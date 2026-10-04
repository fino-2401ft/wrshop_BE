import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor(config: ConfigService) {
    const host = config.get<string>('SMTP_HOST')?.trim();
    const user = config.get<string>('SMTP_USER')?.trim();
    const pass = config.get<string>('SMTP_PASS')?.trim();
    const port = Number(config.get<string>('SMTP_PORT') ?? 587);
    this.from = config.get<string>('MAIL_FROM')?.trim() || user || 'Wild Rift Store <noreply@localhost>';
    this.transporter =
      host && user && pass
        ? nodemailer.createTransport({
            host,
            port,
            secure: port === 465,
            auth: { user, pass },
            connectionTimeout: 10_000,
          })
        : null;
  }

  get configured() {
    return this.transporter !== null;
  }

  async send(to: string, subject: string, text: string) {
    if (!this.transporter) return false;
    await this.transporter.sendMail({ from: this.from, to, subject, text });
    this.logger.log(`Đã gửi mail tới ${to}: ${subject}`);
    return true;
  }
}
