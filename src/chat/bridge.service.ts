import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';

interface BridgeConnection {
  ws: WebSocket | null;
  onMessage: (message: any) => void;
  reconnectTimeout?: NodeJS.Timeout;
}

@Injectable()
export class BridgeService implements OnModuleDestroy {
  private readonly logger = new Logger(BridgeService.name);
  private readonly bridges = new Map<string, BridgeConnection>();
  private readonly gatewayUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.gatewayUrl = this.configService.get<string>(
      'GATEWAY_WS_URL',
      'ws://localhost:38191/ws/chat',
    );
    this.logger.log(`Bridge configured to gateway: ${this.gatewayUrl}`);
  }

  onModuleDestroy() {
    // Clean up all bridges on shutdown
    this.bridges.forEach((bridge, clientId) => {
      this.closeBridge(clientId);
    });
  }

  /**
   * Create a bridge connection for a client
   */
  createBridge(clientId: string, onMessage: (message: any) => void): void {
    // Close existing bridge if any
    if (this.bridges.has(clientId)) {
      this.closeBridge(clientId);
    }

    const bridge: BridgeConnection = {
      ws: null,
      onMessage,
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
        this.logger.log(`[${clientId}] Connected to gateway`);
        bridge.ws = ws;

        // Request initial history
        this.sendMessage(clientId, { type: 'history', limit: 50 });
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.logger.debug(`[${clientId}] Received from gateway: ${JSON.stringify(message).substring(0, 100)}`);
          bridge.onMessage(message);
        } catch (err) {
          this.logger.error(`[${clientId}] Failed to parse gateway message: ${err}`);
        }
      });

      ws.on('close', () => {
        this.logger.log(`[${clientId}] Gateway connection closed`);
        bridge.ws = null;

        // Attempt reconnect after 5 seconds if bridge still exists
        if (this.bridges.has(clientId)) {
          bridge.reconnectTimeout = setTimeout(() => {
            if (this.bridges.has(clientId)) {
              this.connectToGateway(clientId);
            }
          }, 5000);
        }
      });

      ws.on('error', (error) => {
        this.logger.error(`[${clientId}] Gateway connection error: ${error.message}`);
        // Connection will be retried on 'close' event
      });

      bridge.ws = ws;
    } catch (error) {
      this.logger.error(`[${clientId}] Failed to create gateway connection: ${error}`);
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

    if (!bridge.ws || bridge.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(`[${clientId}] Gateway not connected, queuing message`);
      // Could implement message queue here
      return;
    }

    try {
      bridge.ws.send(JSON.stringify(message));
      this.logger.debug(`[${clientId}] Sent to gateway: ${JSON.stringify(message).substring(0, 100)}`);
    } catch (error) {
      this.logger.error(`[${clientId}] Failed to send message: ${error}`);
    }
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
