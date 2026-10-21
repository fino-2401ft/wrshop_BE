import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../orders/mail.service';

const HOLD_MS = 3 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ZALO_URL = 'https://zalo.me/0968893228';

type PaymentOrder = Prisma.OrderGetPayload<{ include: { account: true } }>;

type SepayTx = {
  id?: string;
  transfer_type?: string;
  amount_in?: number;
  transaction_content?: string | null;
  code?: string | null;
};

type SepayBody = {
  id?: number | string | null;
  code?: string | null;
  content?: string | null;
  description?: string | null;
  transferType?: string | null;
  transferAmount?: number | string | null;
};

@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly lastSepayCheck = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  onModuleInit() {
    void this.expireDueOrders();
  }

  @Cron('*/1 * * * *')
  async expireDueOrders() {
    const due = await this.prisma.order.findMany({
      where: {
        status: 'PENDING',
        expiresAt: { lte: new Date() },
        code: { startsWith: this.prefix() },
      },
      select: { id: true },
    });
    for (const order of due) {
      await this.expireOrder(order.id);
    }
  }

  @Cron('*/20 * * * * *')
  async reconcileOpenOrders() {
    const since = new Date(Date.now() - 30 * 60 * 1000);
    const open = await this.prisma.order.findMany({
      where: {
        code: { startsWith: this.prefix() },
        status: { in: ['PENDING', 'EXPIRED'] },
        createdAt: { gte: since },
        account: { status: 'AVAILABLE' },
      },
      include: { account: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    for (const order of open) {
      await this.tryFulfill(order, true).catch((error) => {
        this.logger.warn(
          `Cron đối soát ${order.code} thất bại: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      });
    }
  }

  async checkout(publicCode: number, rawName: string, rawPhone: string, rawEmail: string) {
    this.bankConfig();
    const buyerName = rawName.trim().replace(/\s+/g, ' ');
    const phone = normalizePhone(rawPhone);
    const email = rawEmail.trim().toLowerCase();
    if (buyerName.length < 2) throw new BadRequestException('Nhập họ tên');
    if (!phone) throw new BadRequestException('Số Zalo không hợp lệ');
    const account = await this.prisma.account.findUnique({ where: { publicCode } });
    if (!account || account.status === 'HIDDEN') throw new NotFoundException('Không tìm thấy acc');
    if (account.status === 'SOLD') throw new ConflictException('Acc đã được thanh toán bởi người khác');
    if (account.status !== 'AVAILABLE') throw new ConflictException('Acc này không còn bán');
    if (!account.gameUser.trim() || !account.gamePass.trim()) {
      throw new BadRequestException('Acc chưa đủ thông tin đăng nhập');
    }
    if (account.price <= 0) throw new BadRequestException('Acc chưa có giá');

    const expiresAt = new Date(Date.now() + HOLD_MS);
    const order = await this.createOrder(account.id, buyerName, phone, email, account.price, expiresAt);
    return this.toView({ ...order, account });
  }

  async get(rawCode: string) {
    let order = await this.loadOrder(rawCode);
    if (order.status === 'PAID') return this.deliver(order);
    if (order.status === 'PENDING' && order.expiresAt.getTime() <= Date.now()) {
      await this.expireOrder(order.id);
      const expired = await this.prisma.order.findUnique({ where: { id: order.id }, include: { account: true } });
      if (!expired) throw new NotFoundException('Không tìm thấy đơn');
      order = expired;
    }
    if (order.status !== 'PAID' && order.account.status === 'AVAILABLE') {
      const paid = await this.tryFulfill(order, false);
      if (paid) return paid;
      order =
        (await this.prisma.order.findUnique({ where: { id: order.id }, include: { account: true } })) ?? order;
    }
    return this.toView(order);
  }

  async complete(rawCode: string) {
    const order = await this.loadOrder(rawCode);
    if (order.status === 'PAID') return this.deliver(order);
    if (order.account.status === 'SOLD') return this.toView(order);
    const paid = await this.tryFulfill(order, true);
    if (paid) return paid;
    throw new BadRequestException('Chưa thấy giao dịch khớp. Đợi vài giây hoặc kiểm tra đúng nội dung chuyển khoản.');
  }

  private async tryFulfill(order: PaymentOrder, force: boolean) {
    if (order.status === 'PAID') return this.deliver(order);
    if (order.account.status !== 'AVAILABLE') return null;
    const now = Date.now();
    const last = this.lastSepayCheck.get(order.code) ?? 0;
    if (!force && now - last < 4_000) return null;
    this.lastSepayCheck.set(order.code, now);
    try {
      const match = await this.findSepayPayment(order.code, order.amount);
      if (!match) return null;
      const fulfilled = await this.markPaid(order, match);
      const fresh = await this.prisma.order.findUnique({ where: { id: order.id }, include: { account: true } });
      if (!fresh) return null;
      if (fresh.status === 'PAID') return this.deliver(fulfilled ?? fresh);
      return null;
    } catch (error) {
      if (force) throw error;
      this.logger.warn(
        `Tự kiểm tra SePay cho ${order.code} thất bại: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return null;
    }
  }

  async handleWebhook(authorization: string | undefined, body: unknown) {
    if (!this.authorized(authorization)) throw new UnauthorizedException('Webhook không hợp lệ');
    const payload = this.readPayload(body);
    if (!payload || payload.transferType !== 'in') return { success: true };

    const code = payload.code.trim().toUpperCase();
    if (!code.startsWith(this.prefix())) return { success: true };
    const order = await this.prisma.order.findFirst({
      where: { code: { equals: code, mode: 'insensitive' } },
      include: { account: true },
    });
    if (!order) return { success: true };
    if (order.status === 'PAID') return { success: true };
    if (payload.amount < order.amount) {
      this.logger.warn(`Đơn ${order.code} nhận ${payload.amount} nhỏ hơn ${order.amount}`);
      return { success: true };
    }

    const fulfilled = await this.markPaid(order, payload);
    if (fulfilled) await this.sendCredentials(fulfilled);
    return { success: true };
  }

  private async markPaid(order: PaymentOrder, payload: { id: string; amount: number }) {
    const now = new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const fresh = await tx.order.findUnique({
          where: { id: order.id },
          include: { account: true },
        });
        if (!fresh || fresh.status === 'PAID') return null;
        if (fresh.account.status !== 'AVAILABLE') {
          this.logger.warn(`Đơn ${fresh.code} có tiền vào nhưng acc đã được người khác thanh toán`);
          return null;
        }
        const marked = await tx.order.updateMany({
          where: { id: fresh.id, status: { in: ['PENDING', 'EXPIRED'] }, paidTransactionId: null },
          data: {
            status: 'PAID',
            paidAt: now,
            paidTransactionId: payload.id,
            settlementAmount: payload.amount,
          },
        });
        if (marked.count !== 1) return null;
        const profit = fresh.account.consignment
          ? fresh.account.profit
          : fresh.account.profit !== 0
            ? fresh.account.profit
            : fresh.account.price - fresh.account.cost;
        const sold = await tx.account.updateMany({
          where: { id: fresh.accountId, status: 'AVAILABLE' },
          data: {
            status: 'SOLD',
            heldUntil: null,
            buyerName: fresh.buyerName,
            buyerPhone: fresh.phone,
            buyerEmail: fresh.email ?? '',
            profit,
          },
        });
        if (sold.count !== 1) throw new Error('ACCOUNT_TAKEN');
        return tx.order.findUnique({ where: { id: fresh.id }, include: { account: true } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
      if (error instanceof Error && error.message === 'ACCOUNT_TAKEN') return null;
      throw error;
    }
  }

  private async sendCredentials(order: PaymentOrder) {
    if (!order.email || order.credentialsSentAt) return;
    const account = order.account;
    const text = [
      `Bạn đã thanh toán thành công acc #${account.publicCode} tại Wild Rift Store.`,
      '',
      `Mã thanh toán: ${order.code}`,
      `Số tiền: ${vnd(order.amount)}`,
      '',
      `Tài khoản: ${account.gameUser}`,
      `Mật khẩu: ${account.gamePass}`,
      '',
      'Bạn cần đổi thông tin liên hệ của acc (email, số điện thoại) và đổi mật khẩu ngay sau khi đăng nhập.',
      'Nếu không thấy mail trong hộp thư chính, hãy kiểm tra mục Spam / Thư rác.',
      `Cần hỗ trợ thì nhắn Zalo: ${ZALO_URL}`,
    ].join('\n');
    try {
      const sent = await this.mail.send(order.email, `Acc #${account.publicCode} - Wild Rift Store`, text);
      if (!sent) {
        this.logger.warn(`Chưa cấu hình SMTP nên chưa gửi acc #${account.publicCode}`);
        return;
      }
      await this.prisma.order.update({
        where: { id: order.id },
        data: { credentialsSentAt: new Date() },
      });
    } catch (error) {
      this.logger.error(`Gửi mail acc #${account.publicCode} thất bại`, error instanceof Error ? error.stack : undefined);
    }
  }

  private async createOrder(
    accountId: string,
    buyerName: string,
    phone: string,
    email: string,
    amount: number,
    expiresAt: Date,
  ) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.prisma.order.create({
          data: {
            code: this.paymentCode(),
            accountId,
            buyerName,
            phone,
            email,
            amount,
            status: 'PENDING',
            expiresAt,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && attempt < 4) continue;
        throw error;
      }
    }
    throw new ConflictException('Không tạo được mã thanh toán');
  }

  private async loadOrder(rawCode: string) {
    const code = rawCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,20}$/.test(code)) throw new NotFoundException('Không tìm thấy đơn');
    const order = await this.prisma.order.findFirst({
      where: { code: { equals: code, mode: 'insensitive' } },
      include: { account: true },
    });
    if (!order || !order.code.startsWith(this.prefix())) throw new NotFoundException('Không tìm thấy đơn');
    return order;
  }

  private async deliver(order: PaymentOrder) {
    if (!order.credentialsSentAt) await this.sendCredentials(order);
    const fresh = await this.prisma.order.findUnique({ where: { id: order.id }, include: { account: true } });
    return this.toView(fresh ?? order);
  }

  private async findSepayPayment(code: string, amount: number) {
    const token = this.config.get<string>('SEPAY_API_TOKEN')?.trim() ?? '';
    if (!token) throw new ServiceUnavailableException('Shop chưa cấu hình kiểm tra giao dịch');
    const exact = {
      transfer_type: 'in',
      amount_in_min: String(amount),
      amount_in_max: String(amount),
      per_page: '50',
    };
    const byCode = await this.sepayTransactions(token, { ...exact, q: code });
    const matched = this.pickTransaction(byCode, code, amount);
    if (matched) return matched;
    const byContent = await this.sepayTransactions(token, { ...exact, transaction_content: code });
    const fromContent = this.pickTransaction(byContent, code, amount);
    if (fromContent) return fromContent;
    const recent = await this.sepayTransactions(token, { ...exact, per_page: '100' });
    return this.pickTransaction(recent, code, amount);
  }

  private async sepayTransactions(token: string, query: Record<string, string>) {
    const response = await fetch(`https://userapi.sepay.vn/v2/transactions?${new URLSearchParams(query)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      this.logger.warn(`SePay từ chối kiểm tra giao dịch, HTTP ${response.status}`);
      throw new BadRequestException('Không kiểm tra được giao dịch. Thử lại sau ít phút.');
    }
    const body = (await response.json()) as { data?: SepayTx[] };
    return Array.isArray(body.data) ? body.data : [];
  }

  private pickTransaction(rows: SepayTx[], code: string, amount: number) {
    const needle = code.toUpperCase();
    const hit = rows.find((tx) => {
      const hay = `${tx.code ?? ''} ${tx.transaction_content ?? ''}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
      return (tx.transfer_type ?? 'in') === 'in' && Number(tx.amount_in) >= amount && hay.includes(needle) && tx.id;
    });
    if (!hit?.id) return null;
    return { id: String(hit.id), amount: Number(hit.amount_in) };
  }

  private async expireOrder(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order || order.status !== 'PENDING' || order.expiresAt.getTime() > Date.now()) return;
    await this.prisma.order.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
  }

  private viewStatus(order: PaymentOrder) {
    if (order.status === 'PAID') return 'PAID' as const;
    if (order.account.status === 'SOLD') return 'TAKEN' as const;
    if (order.status === 'EXPIRED' || order.expiresAt.getTime() <= Date.now()) return 'EXPIRED' as const;
    return 'PENDING' as const;
  }

  private toView(order: PaymentOrder) {
    const bank = this.bankConfig();
    const status = this.viewStatus(order);
    const paid = status === 'PAID';
    return {
      code: order.code,
      accountCode: order.account.publicCode,
      amount: order.amount,
      status,
      expiresAt: order.expiresAt,
      email: order.email ?? '',
      qrUrl: qrUrl(bank, order.amount, order.code),
      bankCode: bank.bankCode,
      bankAccount: bank.bankAccount,
      accountName: bank.accountName,
      transferContent: order.code,
      emailSent: Boolean(order.credentialsSentAt),
      credentials: paid
        ? { username: order.account.gameUser, password: order.account.gamePass }
        : null,
    };
  }

  private bankConfig() {
    const bankAccount = this.config.get<string>('SEPAY_BANK_ACCOUNT')?.trim() ?? '';
    const bankCode = (this.config.get<string>('SEPAY_BANK_CODE')?.trim() || 'ACB').toUpperCase();
    const accountName = this.config.get<string>('SEPAY_ACCOUNT_NAME')?.trim() ?? '';
    if (!bankAccount) {
      throw new ServiceUnavailableException('Shop chưa cấu hình số tài khoản nhận tiền');
    }
    return { bankAccount, bankCode, accountName };
  }

  private prefix() {
    const value = (this.config.get<string>('SEPAY_CODE_PREFIX')?.trim() || 'WR').toUpperCase();
    if (!/^[A-Z]{2,5}$/.test(value)) return 'WR';
    return value;
  }

  private paymentCode() {
    let suffix = '';
    for (let i = 0; i < 8; i += 1) suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return `${this.prefix()}${suffix}`;
  }

  private authorized(header: string | undefined) {
    const expected = this.config.get<string>('SEPAY_WEBHOOK_API_KEY')?.trim() ?? '';
    const match = header?.match(/^Apikey\s+(\S+)\s*$/i);
    if (!expected || !match) return false;
    const givenHash = createHash('sha256').update(match[1]).digest();
    const expectedHash = createHash('sha256').update(expected).digest();
    return timingSafeEqual(givenHash, expectedHash);
  }

  private readPayload(body: unknown) {
    if (!body || typeof body !== 'object') return null;
    const raw = body as SepayBody;
    const amount = Number(raw.transferAmount);
    const id = raw.id == null || String(raw.id).trim() === '' ? '' : String(raw.id).trim();
    if (!id || !Number.isFinite(amount)) return null;
    return {
      id,
      code: this.extractCode(raw),
      amount,
      transferType: typeof raw.transferType === 'string' ? raw.transferType : '',
    };
  }

  private extractCode(raw: SepayBody) {
    const explicit = typeof raw.code === 'string' ? raw.code.trim().toUpperCase() : '';
    if (explicit.startsWith(this.prefix())) return explicit;
    const haystack = `${raw.content ?? ''} ${raw.description ?? ''}`.toUpperCase();
    const match = haystack.match(new RegExp(`${this.prefix()}[A-Z0-9]{8}`));
    return match?.[0] ?? explicit;
  }
}

function qrUrl(bank: { bankAccount: string; bankCode: string }, amount: number, code: string) {
  const params = new URLSearchParams({
    acc: bank.bankAccount,
    bank: bank.bankCode,
    amount: String(amount),
    des: code,
  });
  return `https://vietqr.app/img?${params.toString()}`;
}

function vnd(value: number) {
  return `${new Intl.NumberFormat('vi-VN').format(value)} đ`;
}

function normalizePhone(raw: string) {
  const digits = raw.replace(/[^\d+]/g, '').replace(/^\+84/, '0').replace(/^84/, '0');
  if (!/^(0)(3|5|7|8|9)\d{8}$/.test(digits)) return '';
  return digits;
}
