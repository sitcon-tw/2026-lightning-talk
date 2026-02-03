# 🎈 Ball Drop - Real-Time Interactive Application

A real-time interactive ball drop application featuring physics simulation with Matter.js, WebSocket communication, and Gravatar integration.

## Features

### 🖥️ Admin Display Page
- **Secure Login**: Fixed password authentication for admin access
- **Physics Engine**: Real-time 2D physics simulation using Matter.js
- **Customizable Physics**: Adjust gravity and elasticity in real-time
- **Ball Visualization**: Profile images from Gravatar as falling balls with various colors
- **Countdown Timer**: Set and display countdown with automatic start/stop
- **Manual Controls**: Start/stop ball dropping manually
- **Reset Function**: Remove floor to make all balls fall off screen

### 👥 User Page
- **Email Entry**: Users enter their email address
- **Gravatar Preview**: Automatic avatar display for confirmation
- **Waiting Room**: Hold screen until game starts
- **Timer Display**: Real-time countdown when active
- **Drop Button**: Interactive button to drop balls (appears during active period)
- **Rate Limiting**: Maximum one ball per second per user
- **Color Selection**: Choose from 8 vibrant colors for your ball

### 🔧 Server Features
- **WebSocket Rooms**: Separate rooms for display, controllers, and users
- **Rate Limiting**: Server-side enforcement of 1 ball per second per user
- **Payload Validation**: Size limits and data validation
- **Room Filtering**: Messages sent only to relevant rooms
- **Security**: Password protection and input sanitization

## Installation

```bash
# Install dependencies
pnpm install

# Start the server
pnpm start
```

The server will run on `http://localhost:3000` by default.

## Usage

### Environment Variables

```bash
PORT=3000                    # Server port (default: 3000)
ADMIN_PASSWORD=admin123      # Admin password (default: admin123)
```

### Accessing the Application

1. **Admin/Display Screen**: Open `http://localhost:3000/admin.html`
   - Login with the admin password
   - Control physics settings, countdown timer, and game state
   - View all balls dropping in real-time

2. **User Screen**: Open `http://localhost:3000/` or `http://localhost:3000/index.html`
   - Enter your email address
   - Confirm your Gravatar avatar
   - Wait for the game to start
   - Drop balls when the button appears

### Typical Flow

1. Admin opens the display page and logs in
2. Admin sets physics parameters (gravity, elasticity)
3. Admin sets countdown timer (e.g., 60 seconds)
4. Admin clicks "Start Countdown"
5. Admin enables "Allow Ball Dropping"
6. Users join and wait for countdown
7. When countdown reaches zero, users can start dropping balls
8. Each user can drop one ball per second
9. Admin can stop dropping at any time
10. Admin can reset to clear all balls

## Architecture

### WebSocket Rooms

- **`display`**: Admin/display screens receive ball drop events
- **`controllers`**: Admin controls room for sending commands
- **`users`**: Regular users receive game state updates

### Rate Limiting

- Server enforces 1 request per second per socket
- Client-side cooldown display
- Prevents spam and ensures fair play

### Security Features

- Password-protected admin access
- Input validation on all user data
- Payload size limits (1MB max)
- Email length validation
- Color format validation
- Room-based message filtering

## Technology Stack

- **Backend**: Node.js with Express
- **WebSocket**: Socket.IO for real-time communication
- **Physics**: Matter.js for 2D physics simulation
- **Avatars**: Gravatar API for user profile images
- **Frontend**: Vanilla JavaScript, HTML5, CSS3

## File Structure

```
.
├── server.js              # Express + Socket.IO server
├── public/
│   ├── index.html         # User page
│   └── admin.html         # Admin/display page
├── package.json
└── README.md
```

## API Events

### Client → Server

- `admin:login` - Admin authentication
- `user:join` - User joins with email
- `user:drop` - User drops a ball
- `admin:updatePhysics` - Update physics settings
- `admin:toggleDropping` - Enable/disable dropping
- `admin:startCountdown` - Start countdown timer
- `admin:reset` - Reset world (remove floor)

### Server → Client

- `admin:authenticated` - Authentication result
- `user:joined` - User successfully joined
- `user:error` - Error message for user
- `user:dropped` - Confirmation of ball drop
- `ball:add` - New ball to display
- `physics:update` - Physics settings changed
- `dropping:changed` - Dropping state changed
- `countdown:start` - Countdown started
- `countdown:end` - Countdown ended
- `world:reset` - World reset triggered

## Development

```bash
# Run in development mode
pnpm dev
```

## License

Apache-2.0

## Author

Elvis Mao
