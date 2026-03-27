require("dotenv").config();

// tracing.js must be the first require after dotenv so OTel patches are applied before any other module loads
require("./tracing");

const Fastify = require("fastify");
const fastifyStatic = require("@fastify/static");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

// ── Fastify instance ──────────────────────────────────────────────────────────

const fastify = Fastify({ logger: true });

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

if (ADMIN_PASSWORD === "admin123") {
	fastify.log.warn("ADMIN_PASSWORD is using the default value. Set the ADMIN_PASSWORD environment variable before deploying.");
}

// Serve static files from /public
fastify.register(fastifyStatic, {
	root: path.join(__dirname, "public"),
	prefix: "/"
});

// ── Socket.IO (attached to Fastify's underlying http.Server) ──────────────────
// Fastify 5 doesn't have a first-class socket.io plugin; we bind after listen.

const io = new Server({
	maxHttpBufferSize: 1e4, // 10 KB max payload
	cors: { origin: ALLOWED_ORIGIN }
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

const socketEventLimits = new Map(); // socketId -> { [event]: { count, resetTime } }

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

// ── Physics settings ──────────────────────────────────────────────────────────

let physicsSettings = {
	gravity: 1,
	elasticity: 0.8,
	dropping: false,
	countdownActive: false,
	countdownSeconds: 0
};

// ── User count ────────────────────────────────────────────────────────────────

let userCount = 0;
const uniqueEmails = new Set();

function broadcastUserCount() {
	io.to("welcome").emit("users:count", { count: userCount });
	io.to("controllers").emit("admin:stats", {
		online: userCount,
		unique: uniqueEmails.size,
		timestamp: Date.now()
	});
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getGravatarUrl(email) {
	const hash = crypto.createHash("md5").update(email.toLowerCase().trim()).digest("hex");
	return `https://www.gravatar.com/avatar/${hash}?s=100&d=identicon`;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/;

function isValidEmail(email) {
	return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email);
}

// ── Socket.IO event handlers ──────────────────────────────────────────────────

io.on("connection", socket => {
	const ip = socket.handshake.headers["x-forwarded-for"]?.split(",")[0].trim() || socket.handshake.address;
	fastify.log.info({ socketId: socket.id, ip }, "New connection");

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
			fastify.log.info({ socketId: socket.id }, "Admin authenticated");
		} else {
			recordFailedLogin(ip);
			socket.emit("admin:authenticated", { success: false, error: "Invalid password" });
		}
	});

	// Display screen joining
	socket.on("display:join", () => {
		socket.join("display");
		socket.emit("physics:update", physicsSettings);
		fastify.log.info({ socketId: socket.id }, "Display joined");
	});

	// Welcome screen joining
	socket.on("welcome:join", () => {
		socket.join("welcome");
		socket.emit("users:count", { count: userCount });
		fastify.log.info({ socketId: socket.id }, "Welcome screen joined");
	});

	// Request user count (rate limited: 5/sec)
	socket.on("welcome:requestCount", () => {
		if (!socket.rooms.has("welcome")) return;
		if (!checkEventRateLimit(socket.id, "requestCount", 1000, 5)) return;
		socket.emit("users:count", { count: userCount });
	});

	// User joining (rate limited: 3 attempts per 10 seconds)
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

		if (!wasUser) {
			userCount++;
			uniqueEmails.add(data.email.toLowerCase().trim());
			broadcastUserCount();
		}
	});

	// User dropping a ball (rate limited: 1/sec)
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
		fastify.log.info({ dropping: physicsSettings.dropping }, "Dropping toggled");
	});

	socket.on("admin:startCountdown", data => {
		if (!socket.rooms.has("controllers")) return;
		if (typeof data.seconds !== "number" || data.seconds <= 0 || data.seconds > 3600) return;

		physicsSettings.countdownActive = true;
		physicsSettings.countdownSeconds = data.seconds;

		io.emit("countdown:start", { seconds: data.seconds });
		fastify.log.info({ seconds: data.seconds }, "Countdown started");

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
		fastify.log.info("World reset triggered");
	});

	socket.on("admin:forceAutoFill", () => {
		if (!socket.rooms.has("controllers")) return;
		io.to("display").emit("autofill:start");
		fastify.log.info("Auto-fill triggered");
	});

	// Use "disconnecting" so socket.rooms is still populated
	socket.on("disconnecting", () => {
		if (socket.rooms.has("users")) {
			userCount = Math.max(0, userCount - 1);
			setTimeout(() => broadcastUserCount(), 100);
		}
	});

	socket.on("disconnect", () => {
		socketEventLimits.delete(socket.id);
		fastify.log.info({ socketId: socket.id }, "Disconnected");
	});
});

// ── Start ─────────────────────────────────────────────────────────────────────

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
	if (err) {
		fastify.log.error(err);
		process.exit(1);
	}
	// Attach Socket.IO to Fastify's underlying http.Server after listen
	io.attach(fastify.server);
	fastify.log.info(`Server running on ${address}`);
});
