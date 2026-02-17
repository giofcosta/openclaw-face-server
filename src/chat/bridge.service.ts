import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { generateKeyPairSync, sign, createHash } from 'crypto';

interface BridgeConnection {
  ws: WebSocket | null;
  onMessage: (message: any) => void;
  reconnectTimeout?: NodeJS.Timeout;
  authenticated: boolean;
  messageQueue: any[];
  sessionKey?: string;
}

interface GatewayMessage {
  type: 'event' | 'res' | 'req';
  event?: string;
  id?: string;
  method?: string;
  ok?: boolean;
  payload?: any;
  error?: any;
}

interface DeviceIdentity {
  deviceId: string;
  publicKey: string;
  privateKey: Buffer;
}

@Injectable()
export class BridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BridgeService.name);
  private readonly bridges = new Map<string, BridgeConnection>();
  private readonly gatewayUrl: string;
  private readonly gatewayToken: string;
  private deviceIdentity: DeviceIdentity | null = null;

  constructor(private readonly configService: ConfigService) {
    const baseUrl = this.configService.get<string>(
      'GATEWAY_WS_URL',
      'ws://localhost:38191',
    );
    this.gatewayUrl = baseUrl.replace(/\/ws\/chat$/, '').replace(/\/$/, '');
    this.gatewayToken = this.configService.get<string>('GATEWAY_TOKEN', '');

    this.logger.log(`Bridge configured to gateway: ${this.gatewayUrl}`);
    if (this.gatewayToken) {
      this.logger.log('Gateway token configured');
    } else {
      this.logger.warn('No GATEWAY_TOKEN configured - connection may fail');
    }
  }

  async onModuleInit() {
    // Generate device identity on startup
    this.deviceIdentity = this.generateDeviceIdentity();
    this.logger.log(`Device identity initialized: ${this.deviceIdentity.deviceId}`);
  }

  onModuleDestroy() {
    this.bridges.forEach((_, clientId) => {
      this.closeBridge(clientId);
    });
  }

  /**
   * Generate Ed25519 keypair for device identity using Node's crypto
   */
  private generateDeviceIdentity(): DeviceIdentity {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });

    // Extract the raw 32-byte public key from SPKI format
    // SPKI for Ed25519 has a 12-byte header
    const rawPublicKey = publicKey.slice(12);

    // Device ID is SHA-256 hash of raw public key (hex)
    const deviceId = createHash('sha256')
      .update(rawPublicKey)
      .digest('hex');

    // Base64url encode the raw public key
    const publicKeyB64 = rawPublicKey
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    return {
      deviceId,
      publicKey: publicKeyB64,
      privateKey,
    };
  }

  /**
   * Sign a message with the device private key
   */
  private signMessage(message: string): string {
    if (!this.deviceIdentity) {
      throw new Error('Device identity not initialized');
    }

    const messageBuffer = Buffer.from(message, 'utf-8');
    
    // Import the private key from DER format
    const privateKeyObject = require('crypto').createPrivateKey({
      key: this.deviceIdentity.privateKey,
      format: 'der',
      type: 'pkcs8',
    });

    const signature = sign(null, messageBuffer, privateKeyObject);
    
    // Base64url encode the signature
    return signature
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /**
   * Create a bridge connection for a client
   */
  createBridge(clientId: string, onMessage: (message: any) => void): void {
    if (this.bridges.has(clientId)) {
      this.closeBridge(clientId);
    }

    const bridge: BridgeConnection = {
      ws: null,
      onMessage,
      authenticated: false,
      messageQueue: [],
    };

    this.bridges.set(clientId, bridge);
    this.connectToGateway(clientId);
  }

  /**
   * Connect to the OpenClaw gateway WebSocket
   */
  private connectToGateway(clientId: string): void {
    const bridge = this.bridges.get(clientId);
    if (!bridge) return;

    try {
      this.logger.log(`[${clientId}] Connecting to gateway: ${this.gatewayUrl}`);
      const ws = new WebSocket(this.gatewayUrl);

      ws.on('open', () => {
        this.logger.log(`[${clientId}] WebSocket connected, awaiting challenge...`);
        bridge.ws = ws;
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const message: GatewayMessage = JSON.parse(data.toString());
          this.handleGatewayMessage(clientId, message);
        } catch (err) {
          this.logger.error(
            `[${clientId}] Failed to parse gateway message: ${err}`,
          );
        }
      });

      ws.on('close', () => {
        this.logger.log(`[${clientId}] Gateway connection closed`);
        bridge.ws = null;
        bridge.authenticated = false;

        if (this.bridges.has(clientId)) {
          bridge.reconnectTimeout = setTimeout(() => {
            if (this.bridges.has(clientId)) {
              this.connectToGateway(clientId);
            }
          }, 5000);
        }
      });

      ws.on('error', (error) => {
        this.logger.error(
          `[${clientId}] Gateway connection error: ${error.message}`,
        );
      });

      bridge.ws = ws;
    } catch (error) {
      this.logger.error(
        `[${clientId}] Failed to create gateway connection: ${error}`,
      );
    }
  }

  /**
   * Handle messages from the gateway
   */
  private handleGatewayMessage(
    clientId: string,
    message: GatewayMessage,
  ): void {
    const bridge = this.bridges.get(clientId);
    if (!bridge) return;

    this.logger.debug(
      `[${clientId}] Received: ${JSON.stringify(message).substring(0, 200)}`,
    );

    // Handle connect.challenge event
    if (message.type === 'event' && message.event === 'connect.challenge') {
      this.handleConnectChallenge(clientId, message.payload);
      return;
    }

    // Handle connect response
    if (
      message.type === 'res' &&
      message.ok &&
      message.payload?.type === 'hello-ok'
    ) {
      this.handleConnectSuccess(clientId, message.payload);
      return;
    }

    // Handle connect failure
    if (message.type === 'res' && !message.ok) {
      this.logger.error(
        `[${clientId}] Gateway request failed: ${JSON.stringify(message.error)}`,
      );
      bridge.onMessage({
        type: 'error',
        error: message.error,
      });
      return;
    }

    // Handle agent events (streaming responses)
    if (message.type === 'event' && message.event === 'agent') {
      this.handleAgentEvent(clientId, message.payload);
      return;
    }

    // Handle chat events
    if (message.type === 'event' && message.event === 'chat') {
      bridge.onMessage(message.payload);
      return;
    }

    // Ignore internal gateway events (tick, health, presence, etc.)
    // These should not be forwarded to the chat client
    if (message.type === 'event') {
      const ignoredEvents = ['tick', 'health', 'presence', 'heartbeat', 'shutdown'];
      if (ignoredEvents.includes(message.event || '')) {
        this.logger.debug(`[${clientId}] Ignoring internal event: ${message.event}`);
        return;
      }
    }

    // Only forward response messages, not all events
    if (message.type === 'res') {
      bridge.onMessage(message);
    }
  }

  /**
   * Handle the connect.challenge from gateway
   */
  private handleConnectChallenge(
    clientId: string,
    payload: { nonce: string; ts: number },
  ): void {
    const bridge = this.bridges.get(clientId);
    if (!bridge?.ws || !this.deviceIdentity) return;

    this.logger.log(
      `[${clientId}] Received connect.challenge, signing and sending connect request...`,
    );

    const signedAt = Date.now();
    const scopes = ['operator.read', 'operator.write'];
    
    // Build the message to sign (matches gateway's expected format)
    // Format: "v2|deviceId|clientId|clientMode|role|scopes|signedAt|token|nonce"
    const signaturePayload = [
      'v2',
      this.deviceIdentity.deviceId,
      'cli',         // Must match client.id
      'cli',         // Must match client.mode
      'operator',
      scopes.join(','),
      String(signedAt),
      this.gatewayToken || '',
      payload.nonce,
    ].join('|');

    try {
      const signature = this.signMessage(signaturePayload);

      const connectRequest = {
        type: 'req',
        id: uuidv4(),
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: 'cli',        // Use CLI client ID (no origin restrictions)
            version: '1.0.0',
            platform: 'linux',
            mode: 'cli',      // CLI mode
          },
          role: 'operator',
          scopes: scopes,
          caps: [],
          commands: [],
          permissions: {},
          auth: {
            token: this.gatewayToken,
          },
          locale: 'en-US',
          userAgent: 'openclaw-face-bridge/1.0.0',
          device: {
            id: this.deviceIdentity.deviceId,
            publicKey: this.deviceIdentity.publicKey,
            signature: signature,
            signedAt: signedAt,
            nonce: payload.nonce,
          },
        },
      };

      this.sendRaw(clientId, connectRequest);
    } catch (error) {
      this.logger.error(`[${clientId}] Failed to sign challenge: ${error}`);
    }
  }

  /**
   * Handle successful connection (hello-ok)
   */
  private handleConnectSuccess(clientId: string, payload: any): void {
    const bridge = this.bridges.get(clientId);
    if (!bridge) return;

    this.logger.log(`[${clientId}] Gateway authentication successful!`);
    bridge.authenticated = true;

    // Process any queued messages
    while (bridge.messageQueue.length > 0) {
      const queuedMsg = bridge.messageQueue.shift();
      this.sendMessage(clientId, queuedMsg);
    }

    // Notify client of successful connection
    bridge.onMessage({
      type: 'gateway_connected',
      payload: { status: 'connected' },
    });
  }

  /**
   * Handle agent events (streaming responses from the AI)
   */
  private handleAgentEvent(clientId: string, payload: any): void {
    const bridge = this.bridges.get(clientId);
    if (!bridge) return;

    if (payload.delta?.text) {
      bridge.onMessage({
        type: 'response',
        content: payload.delta.text,
        streaming: true,
        runId: payload.runId,
      });
    } else if (payload.status === 'completed' || payload.status === 'done') {
      bridge.onMessage({
        type: 'response_complete',
        runId: payload.runId,
      });
    }
  }

  /**
   * Send raw message to gateway (bypasses authentication check)
   */
  private sendRaw(clientId: string, message: any): void {
    const bridge = this.bridges.get(clientId);
    if (!bridge?.ws || bridge.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(`[${clientId}] Cannot send - WebSocket not open`);
      return;
    }

    try {
      bridge.ws.send(JSON.stringify(message));
      this.logger.debug(
        `[${clientId}] Sent raw: ${JSON.stringify(message).substring(0, 150)}`,
      );
    } catch (error) {
      this.logger.error(`[${clientId}] Failed to send: ${error}`);
    }
  }

  /**
   * Send a message through the bridge to the gateway
   */
  sendMessage(clientId: string, message: any): void {
    const bridge = this.bridges.get(clientId);
    if (!bridge) {
      this.logger.warn(`[${clientId}] No bridge found`);
      return;
    }

    if (!bridge.authenticated) {
      this.logger.debug(`[${clientId}] Queueing message (not authenticated)`);
      bridge.messageQueue.push(message);
      return;
    }

    if (!bridge.ws || bridge.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(`[${clientId}] Gateway not connected, queueing message`);
      bridge.messageQueue.push(message);
      return;
    }

    const gatewayMessage = this.convertToGatewayFormat(clientId, message);

    try {
      bridge.ws.send(JSON.stringify(gatewayMessage));
      this.logger.debug(
        `[${clientId}] Sent: ${JSON.stringify(gatewayMessage).substring(0, 150)}`,
      );
    } catch (error) {
      this.logger.error(`[${clientId}] Failed to send message: ${error}`);
    }
  }

  /**
   * Convert frontend message format to gateway protocol format
   */
  private convertToGatewayFormat(clientId: string, message: any): any {
    const bridge = this.bridges.get(clientId);

    if (message.type === 'message' && message.text) {
      const reqId = uuidv4();
      return {
        type: 'req',
        id: reqId,
        method: 'agent',
        params: {
          message: message.text,
          sessionKey: bridge?.sessionKey || 'main',
          idempotencyKey: reqId, // Required by gateway
        },
      };
    }

    if (message.type === 'history') {
      return {
        type: 'req',
        id: uuidv4(),
        method: 'sessions.history',
        params: {
          sessionKey: bridge?.sessionKey || 'main',
          limit: message.limit || 50,
        },
      };
    }

    return message;
  }

  /**
   * Close a bridge connection
   */
  closeBridge(clientId: string): void {
    const bridge = this.bridges.get(clientId);
    if (!bridge) return;

    if (bridge.reconnectTimeout) {
      clearTimeout(bridge.reconnectTimeout);
    }

    if (bridge.ws) {
      try {
        bridge.ws.close();
      } catch (e) {
        // Ignore close errors
      }
    }

    this.bridges.delete(clientId);
    this.logger.log(`[${clientId}] Bridge closed`);
  }
}
