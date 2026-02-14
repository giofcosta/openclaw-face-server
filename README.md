# OpenClaw Face Server

A secure WebSocket bridge server that connects the OpenClaw Face frontend to the OpenClaw gateway. Built with NestJS.

## Features

- 🔐 **JWT-based Authentication** - API key exchange for secure JWT tokens
- 🌐 **WebSocket Bridge** - Real-time bidirectional messaging between frontend and gateway
- 🛡️ **CORS Protection** - Configurable allowed origins
- ⚡ **Rate Limiting** - Built-in throttling to prevent abuse
- 🏥 **Health Checks** - Ready and health endpoints for monitoring

## Prerequisites

- Node.js 18+ 
- npm or yarn
- OpenClaw gateway running (for full functionality)

## Installation

```bash
# Clone the repository
git clone https://github.com/giofcosta/openclaw-face-server.git
cd openclaw-face-server

# Install dependencies
npm install

# Copy environment file and configure
cp .env.example .env
# Edit .env with your settings
```

## Configuration

Edit the `.env` file with your settings:

```env
# Server Configuration
PORT=18795
NODE_ENV=production

# JWT Configuration (CHANGE THESE IN PRODUCTION!)
JWT_SECRET=your-super-secret-jwt-key-change-this
JWT_EXPIRATION=30m

# API Key for authentication (client must provide this to get JWT)
API_KEY=your-secure-api-key

# OpenClaw Gateway WebSocket URL
GATEWAY_WS_URL=ws://localhost:38191/ws/chat

# CORS Configuration (comma-separated origins)
ALLOWED_ORIGINS=https://your-frontend-domain.com

# Rate Limiting
THROTTLE_TTL=60
THROTTLE_LIMIT=100
```

### Security Notes

⚠️ **Important**: Change the following in production:
- `JWT_SECRET` - Use a strong, random secret (min 32 characters)
- `API_KEY` - Use a secure, random API key
- `ALLOWED_ORIGINS` - Restrict to your actual frontend domains

## Running the Server

```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

## API Endpoints

### Authentication

**POST /auth/token**

Exchange API key for JWT token.

```bash
curl -X POST http://localhost:18795/auth/token \
  -H "Content-Type: application/json" \
  -d '{"apiKey": "your-api-key"}'
```

Response:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": "30m"
}
```

### Health Checks

**GET /health**
```bash
curl http://localhost:18795/health
```

**GET /health/ready**
```bash
curl http://localhost:18795/health/ready
```

## WebSocket Connection

### Endpoint

```
wss://your-server:18795/chat
```

### Authentication

Include the JWT token in one of these ways:
- Query parameter: `wss://server:18795/chat?token=YOUR_JWT_TOKEN`
- Auth object: `{ auth: { token: 'YOUR_JWT_TOKEN' } }`

### Events

**Client → Server:**
- `message` - Send a chat message: `{ text: "Hello" }`
- `history` - Request message history: `{ limit: 50 }`
- `typing` - Notify user is typing

**Server → Client:**
- `connected` - Connection successful
- `message` - New message received
- `typing` - Bot is typing indicator
- `error` - Error occurred

## Frontend Integration

### Step 1: Obtain JWT Token

```javascript
const API_KEY = 'your-api-key';
const SERVER_URL = 'https://your-server:18795';

async function getToken() {
  const response = await fetch(`${SERVER_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: API_KEY }),
  });
  const data = await response.json();
  return data.accessToken;
}
```

### Step 2: Connect to WebSocket

```javascript
import { io } from 'socket.io-client';

const token = await getToken();
const socket = io('wss://your-server:18795/chat', {
  auth: { token },
});

socket.on('connected', () => {
  console.log('Connected to chat server');
});

socket.on('message', (msg) => {
  console.log('New message:', msg);
});

socket.on('error', (err) => {
  console.error('Error:', err);
});

// Send a message
socket.emit('message', { text: 'Hello!' });
```

### Step 3: Update useChat Hook

Update the frontend's `useChat` hook to use Socket.IO instead of raw WebSocket:

```javascript
import { io, Socket } from 'socket.io-client';

const BRIDGE_URL = 'https://your-server:18795';
const API_KEY = 'your-api-key';

export function useChat() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [token, setToken] = useState<string | null>(null);
  
  // Get token on mount
  useEffect(() => {
    fetch(`${BRIDGE_URL}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: API_KEY }),
    })
      .then(res => res.json())
      .then(data => setToken(data.accessToken));
  }, []);
  
  // Connect when token is available
  useEffect(() => {
    if (!token) return;
    
    const sock = io(`${BRIDGE_URL}/chat`, {
      auth: { token },
    });
    
    sock.on('message', handleMessage);
    sock.on('typing', handleTyping);
    
    setSocket(sock);
    
    return () => { sock.disconnect(); };
  }, [token]);
  
  // ... rest of hook
}
```

## Nginx Configuration (TLS Termination)

For production, terminate TLS at nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name face-server.yourdomain.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    # WebSocket support
    location /chat {
        proxy_pass http://localhost:18795;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    # HTTP API
    location / {
        proxy_pass http://localhost:18795;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## PM2 Deployment

```bash
# Install PM2
npm install -g pm2

# Start with PM2
pm2 start dist/main.js --name openclaw-face-server

# Auto-start on boot
pm2 startup
pm2 save
```

## Architecture

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│                 │  WSS    │                 │   WS    │                 │
│    Frontend     │◄───────►│  Bridge Server  │◄───────►│ OpenClaw Gateway│
│  (React/Vite)   │         │   (NestJS)      │         │                 │
│                 │         │                 │         │                 │
└─────────────────┘         └─────────────────┘         └─────────────────┘
        │                           │
        │                           │
        ▼                           ▼
   ┌─────────┐               ┌─────────────┐
   │  User   │               │ JWT Auth +  │
   │ Browser │               │ Rate Limit  │
   └─────────┘               └─────────────┘
```

## Troubleshooting

### Connection refused
- Ensure the server is running: `npm run start:dev`
- Check the port is not in use: `lsof -i :18795`
- Verify CORS origins include your frontend URL

### Authentication failed
- Verify API_KEY in .env matches what frontend sends
- Check JWT_SECRET is set
- Ensure token hasn't expired

### Gateway connection failed
- Verify GATEWAY_WS_URL is correct
- Ensure OpenClaw gateway is running
- Check firewall allows connection

## License

MIT
