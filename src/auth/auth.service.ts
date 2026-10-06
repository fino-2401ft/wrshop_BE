import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

type AttemptState = { fails: number; lockedUntil: number };

@Injectable()
export class AuthService {
  private readonly attempts = new Map<string, AttemptState>();
  private readonly maxFails = 3;
  private readonly lockMs = 15 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(username: string, password: string, clientKey = '') {
    const key = `${clientKey}|${username.trim().toLowerCase()}`;
    this.assertNotLocked(key);

    const admin = await this.prisma.admin.findUnique({ where: { username } });
    const ok = admin && (await bcrypt.compare(password, admin.passwordHash));
    if (!ok) {
      this.recordFail(key);
      throw new UnauthorizedException('Sai tên đăng nhập hoặc mật khẩu');
    }

    this.attempts.delete(key);
    const accessToken = await this.jwt.signAsync({ sub: admin!.id, username: admin!.username });
    return { accessToken, username: admin!.username };
  }

  private assertNotLocked(key: string) {
    const state = this.attempts.get(key);
    if (!state?.lockedUntil) return;
    const leftMs = state.lockedUntil - Date.now();
    if (leftMs <= 0) {
      this.attempts.delete(key);
      return;
    }
    const minutes = Math.max(1, Math.ceil(leftMs / 60000));
    throw new HttpException(
      `Đăng nhập sai quá 3 lần. Thử lại sau khoảng ${minutes} phút.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private recordFail(key: string) {
    const prev = this.attempts.get(key);
    const fails = (prev?.fails ?? 0) + 1;
    if (fails >= this.maxFails) {
      this.attempts.set(key, { fails, lockedUntil: Date.now() + this.lockMs });
      throw new HttpException(
        'Đăng nhập sai quá 3 lần. Tài khoản tạm khóa 15 phút.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.attempts.set(key, { fails, lockedUntil: 0 });
  }
}
