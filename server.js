const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const httpServer = createServer(app);

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const io = new Server(httpServer, {
	maxHttpBufferSize: 1e4, // 10KB max payload — emails are tiny
	cors: {
		origin: ALLOWED_ORIGIN
	}
});

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

if (ADMIN_PASSWORD === "admin123") {
	console.warn("[WARN] ADMIN_PASSWORD is using the default value. Set the ADMIN_PASSWORD environment variable before deploying.");
}

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// ── Rate limiting ────────────────────────────────────────────────────────────

// General per-socket rate limit (for drop, join, etc.)
const socketEventLimits = new Map(); // socketId -> { [event]: { count, resetTime } }

/**
 * Returns true if the event is within its allowed rate.
 * windowMs: rolling window in ms
 * max: max calls per window
 */
function checkEventRateLimit(socketId, event, windowMs, max) {
	const now = Date.now();
	if (!socketEventLimits.has(socketId)) socketEventLimits.set(socketId, {});
	const limits = socketEventLimits.get(socketId);

	if (!limits[event] || now > limits[event].resetTime) {
		limits[event] = { count: 1, resetTime: now + windowMs };
		return true;
	}
	if (limits[event].count >= max) return false;
	limits[event].count++;
	return true;
}

// Brute-force protection for admin:login — per IP
const loginAttempts = new Map(); // ip -> { count, lockedUntil }
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000; // 15 minutes

function checkLoginAllowed(ip) {
	const now = Date.now();
	const entry = loginAttempts.get(ip);
	if (!entry) return true;
	if (entry.lockedUntil && now < entry.lockedUntil) return false;
	if (now > entry.resetTime) {
		loginAttempts.delete(ip);
		return true;
	}
	return true;
}

function recordFailedLogin(ip) {
	const now = Date.now();
	const entry = loginAttempts.get(ip) || { count: 0, resetTime: now + LOGIN_LOCK_MS };
	entry.count++;
	if (entry.count >= LOGIN_MAX_ATTEMPTS) {
		entry.lockedUntil = now + LOGIN_LOCK_MS;
	}
	loginAttempts.set(ip, entry);
}

function recordSuccessfulLogin(ip) {
	loginAttempts.delete(ip);
}

// Clean up stale entries every 5 minutes
setInterval(
	() => {
		const now = Date.now();
		for (const [socketId, limits] of socketEventLimits.entries()) {
			// Remove if all events are expired
			const allExpired = Object.values(limits).every(l => now > l.resetTime + 60000);
			if (allExpired) socketEventLimits.delete(socketId);
		}
		for (const [ip, entry] of loginAttempts.entries()) {
			if (!entry.lockedUntil && now > entry.resetTime) loginAttempts.delete(ip);
			if (entry.lockedUntil && now > entry.lockedUntil + LOGIN_LOCK_MS) loginAttempts.delete(ip);
		}
	},
	5 * 60 * 1000
);

// ── Physics settings ─────────────────────────────────────────────────────────

let physicsSettings = {
	gravity: 1,
	elasticity: 0.8,
	dropping: false,
	countdownActive: false,
	countdownSeconds: 0
};

// ── User count (O(1) counter) ─────────────────────────────────────────────────

let userCount = 0;
const uniqueEmails = new Set(); // tracks unique email addresses ever joined

function broadcastUserCount() {
	io.to("welcome").emit("users:count", { count: userCount });
	io.to("controllers").emit("admin:stats", {
		online: userCount,
		unique: uniqueEmails.size,
		timestamp: Date.now()
	});
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getGravatarUrl(email) {
	const hash = crypto.createHash("md5").update(email.toLowerCase().trim()).digest("hex");
	return `https://www.gravatar.com/avatar/${hash}?s=100&d=identicon`;
}

// Basic email format validation (RFC-lite — just needs a local@domain shape)
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/;

function isValidEmail(email) {
	return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email);
}

// ── Socket.IO ────────────────────────────────────────────────────────────────

io.on("connection", socket => {
	const ip = socket.handshake.headers["x-forwarded-for"]?.split(",")[0].trim() || socket.handshake.address;
	console.log("New connection:", socket.id, "from", ip);

	// Admin authentication
	socket.on("admin:login", data => {
		if (!data || typeof data.password !== "string") return;

		if (!checkLoginAllowed(ip)) {
			socket.emit("admin:authenticated", { success: false, error: "Too many failed attempts. Try again later." });
			return;
		}

		if (data.password === ADMIN_PASSWORD) {
			recordSuccessfulLogin(ip);
			socket.join("controllers");
			socket.emit("admin:authenticated", { success: true });
			socket.emit("physics:update", physicsSettings);
			socket.emit("admin:stats", {
				online: userCount,
				unique: uniqueEmails.size,
				timestamp: Date.now()
			});
			console.log("Admin authenticated:", socket.id);
		} else {
			recordFailedLogin(ip);
			socket.emit("admin:authenticated", { success: false, error: "Invalid password" });
		}
	});

	// Display screen joining
	socket.on("display:join", () => {
		socket.join("display");
		socket.emit("physics:update", physicsSettings);
		console.log("Display joined:", socket.id);
	});

	// Welcome screen joining
	socket.on("welcome:join", () => {
		socket.join("welcome");
		socket.emit("users:count", { count: userCount });
		console.log("Welcome screen joined:", socket.id);
	});

	// Request user count (rate limited: 5/sec)
	socket.on("welcome:requestCount", () => {
		if (!socket.rooms.has("welcome")) return;
		if (!checkEventRateLimit(socket.id, "requestCount", 1000, 5)) return;
		socket.emit("users:count", { count: userCount });
	});

	// User joining (rate limited: 3 attempts per 10 seconds to prevent spam joins)
	socket.on("user:join", data => {
		if (!checkEventRateLimit(socket.id, "user:join", 10000, 3)) {
			socket.emit("user:error", { error: "Too many join attempts." });
			return;
		}

		if (!data || !isValidEmail(data.email)) {
			socket.emit("user:error", { error: "Invalid email" });
			return;
		}

		const wasUser = socket.rooms.has("users");
		socket.join("users");

		const gravatarUrl = getGravatarUrl(data.email);
		socket.data.email = data.email;
		socket.data.gravatarUrl = gravatarUrl;

		socket.emit("user:joined", {
			email: data.email,
			gravatarUrl,
			dropping: physicsSettings.dropping,
			countdownActive: physicsSettings.countdownActive
		});

		// Only increment if this socket wasn't already counted
		if (!wasUser) {
			userCount++;
			uniqueEmails.add(data.email.toLowerCase().trim());
			broadcastUserCount();
		}
	});

	// User dropping a ball (rate limited: 1/sec, enforced server-side)
	socket.on("user:drop", () => {
		if (!socket.rooms.has("users")) return;
		if (!physicsSettings.dropping) {
			socket.emit("user:error", { error: "Dropping not allowed currently" });
			return;
		}
		if (!checkEventRateLimit(socket.id, "user:drop", 1000, 1)) {
			socket.emit("user:error", { error: "Rate limit exceeded. Wait 1 second between drops." });
			return;
		}

		const color =
			"#" +
			Math.floor(Math.random() * 16777215)
				.toString(16)
				.padStart(6, "0");

		io.to("display").emit("ball:add", {
			gravatarUrl: socket.data.gravatarUrl,
			color,
			timestamp: Date.now()
		});

		socket.emit("user:dropped", {
			success: true,
			nextDropTime: Date.now() + 1000
		});
	});

	// Admin controls
	socket.on("admin:updatePhysics", data => {
		if (!socket.rooms.has("controllers")) return;
		if (typeof data.gravity === "number" && data.gravity >= 0 && data.gravity <= 5) physicsSettings.gravity = data.gravity;
		if (typeof data.elasticity === "number" && data.elasticity >= 0 && data.elasticity <= 1) physicsSettings.elasticity = data.elasticity;
		io.to("display").emit("physics:update", physicsSettings);
	});

	socket.on("admin:toggleDropping", data => {
		if (!socket.rooms.has("controllers")) return;
		physicsSettings.dropping = !!data.dropping;
		io.to("users").emit("dropping:changed", { dropping: physicsSettings.dropping });
		io.to("display").emit("dropping:changed", { dropping: physicsSettings.dropping });
		console.log("Dropping toggled:", physicsSettings.dropping);
	});

	socket.on("admin:startCountdown", data => {
		if (!socket.rooms.has("controllers")) return;
		if (typeof data.seconds !== "number" || data.seconds <= 0 || data.seconds > 3600) return;

		physicsSettings.countdownActive = true;
		physicsSettings.countdownSeconds = data.seconds;

		io.emit("countdown:start", { seconds: data.seconds });
		console.log("Countdown started:", data.seconds);

		setTimeout(() => {
			if (physicsSettings.countdownActive) {
				physicsSettings.dropping = false;
				physicsSettings.countdownActive = false;
				io.to("users").emit("dropping:changed", { dropping: false });
				io.to("display").emit("dropping:changed", { dropping: false });
				io.emit("countdown:end");
			}
		}, data.seconds * 1000);
	});

	socket.on("admin:reset", () => {
		if (!socket.rooms.has("controllers")) return;
		io.to("display").emit("world:reset");
		console.log("World reset triggered");
	});

	socket.on("admin:forceAutoFill", () => {
		if (!socket.rooms.has("controllers")) return;
		io.to("display").emit("autofill:start");
		console.log("Auto-fill triggered");
	});

	// Use "disconnecting" (not "disconnect") because rooms are still populated at this stage.
	// By the time "disconnect" fires, socket.rooms has already been cleared.
	socket.on("disconnecting", () => {
		if (socket.rooms.has("users")) {
			userCount = Math.max(0, userCount - 1);
			setTimeout(() => broadcastUserCount(), 100);
		}
	});

	socket.on("disconnect", () => {
		socketEventLimits.delete(socket.id);
		console.log("Disconnected:", socket.id);
	});
});

httpServer.listen(PORT, "0.0.0.0", () => {
	console.log(`Server running on http://localhost:${PORT}`);
});
