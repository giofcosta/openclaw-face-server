import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { GetTokenDto } from './dto/get-token.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Exchange API key for JWT token
   * POST /auth/token
   * Body: { "apiKey": "your-api-key" }
   */
  @Post('token')
  @HttpCode(HttpStatus.OK)
  async getToken(@Body() dto: GetTokenDto) {
    return this.authService.getToken(dto.apiKey);
  }
}
