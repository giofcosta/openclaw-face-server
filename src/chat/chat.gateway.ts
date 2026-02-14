import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { BridgeService } from './bridge.service';

@WebSocketGateway({
  namespace: '/chat',
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true,
  },
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);
  private authenticatedClients = new Map<string, boolean>();

  constructor(
    private readonly authService: AuthService,
    private readonly bridgeService: BridgeService,
  ) {}

  afterInit() {
    this.logger.log('WebSocket Gateway initialized');
  }

  async handleConnection(client: Socket) {
    this.logger.log(`Client connecting: ${client.id}`);

    // Extract token from query or auth header
    const token =
      (client.handshake.query.token as string) ||
      client.handshake.auth?.token ||
      client.handshake.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      this.logger.warn(`Client ${client.id} - No token provided`);
      client.emit('error', { message: 'Authentication required' });
      client.disconnect();
      return;
    }

    // Validate token
    const isValid = await this.authService.validateToken(token);
    if (!isValid) {
      this.logger.warn(`Client ${client.id} - Invalid token`);
      client.emit('error', { message: 'Invalid or expired token' });
      client.disconnect();
      return;
    }

    this.authenticatedClients.set(client.id, true);
    this.logger.log(`Client ${client.id} authenticated successfully`);

    // Setup bridge connection for this client
    this.bridgeService.createBridge(client.id, (message) => {
      client.emit('message', message);
    });

    // Send connection success
    client.emit('connected', { message: 'Connected to OpenClaw Face Server' });
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.authenticatedClients.delete(client.id);
    this.bridgeService.closeBridge(client.id);
  }

  @SubscribeMessage('message')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { text: string },
  ) {
    if (!this.authenticatedClients.get(client.id)) {
      client.emit('error', { message: 'Not authenticated' });
      return;
    }

    if (!payload?.text?.trim()) {
      return;
    }

    this.logger.log(`Message from ${client.id}: ${payload.text.substring(0, 50)}...`);

    // Forward message to OpenClaw gateway via bridge
    this.bridgeService.sendMessage(client.id, {
      type: 'message',
      text: payload.text.trim(),
    });

    // Emit typing indicator (bot is processing)
    client.emit('typing', { isTyping: true });
  }

  @SubscribeMessage('history')
  async handleHistory(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { limit?: number },
  ) {
    if (!this.authenticatedClients.get(client.id)) {
      client.emit('error', { message: 'Not authenticated' });
      return;
    }

    // Request history from bridge
    this.bridgeService.sendMessage(client.id, {
      type: 'history',
      limit: payload?.limit || 50,
    });
  }

  @SubscribeMessage('typing')
  handleTyping(@ConnectedSocket() client: Socket) {
    if (!this.authenticatedClients.get(client.id)) {
      return;
    }

    // Notify bridge that user is typing
    this.bridgeService.sendMessage(client.id, {
      type: 'user_typing',
    });
  }
}
