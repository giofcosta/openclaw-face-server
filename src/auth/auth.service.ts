import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthService {
  private readonly apiKey: string;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.apiKey = this.configService.get<string>('API_KEY', '');
  }

  /**
   * Validate API key and issue JWT token
   */
  async getToken(apiKey: string): Promise<{ accessToken: string; expiresIn: string }> {
    if (!apiKey || apiKey !== this.apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    const payload = {
      sub: 'chat-client',
      type: 'access',
      iat: Math.floor(Date.now() / 1000),
    };

    const accessToken = this.jwtService.sign(payload);
    const expiresIn = this.configService.get<string>('JWT_EXPIRATION', '30m');

    return { accessToken, expiresIn };
  }

  /**
   * Validate JWT token (used by WebSocket gateway)
   */
  async validateToken(token: string): Promise<boolean> {
    try {
      const payload = this.jwtService.verify(token);
      return payload && payload.sub === 'chat-client';
    } catch {
      return false;
    }
  }
}
