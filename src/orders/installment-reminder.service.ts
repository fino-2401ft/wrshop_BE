import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { addDays, daysUntil } from '../common/vn-date';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from './mail.service';

const DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class InstallmentReminderService implements OnModuleInit {
  private readonly logger = new Logger(InstallmentReminderService.name);
  private warned = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  onModuleInit() {
    void this.remindDueAccounts();
  }

  @Cron('0 8 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async remindDueAccounts() {
    await this.ensureDueDates();
    if (!this.mail.configured) {
      if (!this.warned) {
        this.logger.warn('Chưa cấu hình SMTP nên chưa gửi được mail nhắc hạn tất toán.');
        this.warned = true;
      }
      return;
    }
    const accounts = await this.prisma.account.findMany({
      where: { status: 'RESERVED', dueAt: { not: null } },
    });
    for (const account of accounts) {
      if (!account.dueAt || !account.buyerEmail) continue;
      const left = daysUntil(account.dueAt);
      if (left <= 3 && left > 0 && !account.reminded3dAt) {
        await this.sendOnce(account.id, 'reminded3dAt', account.buyerEmail, this.soonText(account, left));
      }
      if (left <= 0 && !account.remindedDueAt) {
        await this.sendOnce(account.id, 'remindedDueAt', account.buyerEmail, this.dueText(account, left));
      }
    }
  }

  async dueSoon() {
    await this.ensureDueDates();
    const accounts = await this.prisma.account.findMany({
      where: { status: 'RESERVED' },
      include: {
        shopCategory: { select: { title: true } },
        orders: { where: { code: { startsWith: 'DH-' } }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { dueAt: 'asc' },
    });
    return accounts
      .map((account) => {
        const paid = Math.min(Math.max(account.contributed, 0), account.price);
        const dueAt = account.dueAt ?? addDays(new Date(), 30);
        return {
          orderId: account.orders[0]?.id ?? '',
          accountId: account.id,
          code: account.orders[0]?.code ?? `DH-${account.publicCode}`,
          accountCode: account.publicCode,
          categoryTitle: account.shopCategory.title,
          gameUser: account.gameUser,
          gamePass: account.gamePass,
          buyerName: account.buyerName,
          email: account.buyerEmail || null,
          phone: account.buyerPhone,
          remaining: account.price - paid,
          dueAt,
          daysLeft: daysUntil(dueAt),
          remindedSoon: Boolean(account.reminded3dAt),
          remindedDue: Boolean(account.remindedDueAt),
          hasEmail: Boolean(account.buyerEmail),
        };
      })
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }

  private async ensureDueDates() {
    const missing = await this.prisma.account.findMany({
      where: { status: 'RESERVED', dueAt: null },
      include: {
        orders: { where: { code: { startsWith: 'DH-' } }, orderBy: { createdAt: 'asc' }, take: 1 },
      },
    });
    for (const account of missing) {
      const start = account.orders[0]?.createdAt ?? account.updatedAt;
      const dueAt = new Date(start.getTime() + 30 * DAY);
      await this.prisma.account.update({ where: { id: account.id }, data: { dueAt } });
      if (account.orders[0]) {
        await this.prisma.order.update({ where: { id: account.orders[0].id }, data: { expiresAt: dueAt } });
      }
    }
  }

  private soonText(account: { publicCode: number; price: number; contributed: number; dueAt: Date | null; buyerName: string }, left: number) {
    const paid = Math.min(Math.max(account.contributed, 0), account.price);
    const name = account.buyerName.trim() || 'bạn';
    const due = account.dueAt ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'long', timeZone: 'Asia/Ho_Chi_Minh' }).format(account.dueAt) : '';
    return [
      `Xin chào ${name},`,
      '',
      `Acc #${account.publicCode} bạn đang trả góp tại Wild Rift Store còn ${left} ngày nữa là đến hạn tất toán (${due}).`,
      `Số tiền còn thiếu: ${new Intl.NumberFormat('vi-VN').format(account.price - paid)} đ.`,
      'Vui lòng thanh toán trước hạn. Nếu cần hỗ trợ, nhắn Zalo 0968.893.228.',
      '',
      'Wild Rift Store',
    ].join('\n');
  }

  private dueText(account: { publicCode: number; price: number; contributed: number; buyerName: string }, left: number) {
    const paid = Math.min(Math.max(account.contributed, 0), account.price);
    const name = account.buyerName.trim() || 'bạn';
    const when = left < 0 ? `đã quá hạn ${-left} ngày` : 'đến hạn tất toán hôm nay';
    return [
      `Xin chào ${name},`,
      '',
      `Acc #${account.publicCode} bạn đang trả góp tại Wild Rift Store ${when}.`,
      `Số tiền còn thiếu: ${new Intl.NumberFormat('vi-VN').format(account.price - paid)} đ.`,
      'Vui lòng thanh toán để tất toán. Nếu cần hỗ trợ, nhắn Zalo 0968.893.228.',
      '',
      'Wild Rift Store',
    ].join('\n');
  }

  private async sendOnce(
    accountId: string,
    field: 'reminded3dAt' | 'remindedDueAt',
    email: string,
    text: string,
  ) {
    const claimed = await this.prisma.account.updateMany({
      where: { id: accountId, status: 'RESERVED', [field]: null },
      data: { [field]: new Date() },
    });
    if (claimed.count === 0) return;
    const subject = field === 'reminded3dAt' ? 'Nhắc hạn tất toán còn 3 ngày' : 'Nhắc đến hạn tất toán';
    try {
      const sent = await this.mail.send(email, `Wild Rift Store - ${subject}`, text);
      if (!sent) {
        await this.prisma.account.update({ where: { id: accountId }, data: { [field]: null } });
      }
    } catch (error) {
      this.logger.error(`Gửi mail nhắc hạn thất bại: ${error instanceof Error ? error.message : 'lỗi không rõ'}`);
      await this.prisma.account.update({ where: { id: accountId }, data: { [field]: null } });
    }
  }
}
