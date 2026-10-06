import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { clearAuthCookie, setAuthCookie } from './auth-cookie';
import { LoginDto } from './dto';
import { JwtAuthGuard } from './jwt-auth.guard';

type AuthRequest = Request & { user: { id: string; username: string } };

@Controller('api/admin/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ||
      req.ip ||
      req.socket.remoteAddress ||
      '';
    const result = await this.auth.login(dto.username, dto.password, ip);
    setAuthCookie(req, res, result.accessToken);
    return { username: result.username };
  }

  @Post('logout')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    clearAuthCookie(req, res);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: AuthRequest) {
    return { username: req.user.username };
  }
}
