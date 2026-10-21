import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { daysUntil } from '../common/vn-date';
import { PrismaService } from '../prisma/prisma.service';
import { InstallmentReminderService } from './installment-reminder.service';
import { MailService } from './mail.service';

class ListOrdersQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/)
  month?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;
}

function monthBounds(month: string) {
  const [year, mon] = month.split('-').map(Number);
  if (!year || !mon || mon < 1 || mon > 12) return null;
  return {
    start: new Date(Date.UTC(year, mon - 1, 1, -7, 0, 0, 0)),
    end: new Date(Date.UTC(year, mon, 1, -7, 0, 0, 0)),
  };
}

@Controller('api/admin/orders')
@UseGuards(JwtAuthGuard)
export class AdminOrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reminders: InstallmentReminderService,
    private readonly mail: MailService,
  ) {}

  @Get()
  async list(@Query() query: ListOrdersQuery) {
    await this.backfillSaleOrders();
    await this.reminders.remindDueAccounts();
    const dueSoon = await this.reminders.dueSoon();
    const page = query.page ?? 1;
    const pageSize = 20;
    const now = new Date();
    const month = query.month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const bounds = monthBounds(month);
    const createdInMonth = bounds ? { gte: bounds.start, lt: bounds.end } : undefined;
    const where = this.whereFor(createdInMonth, query.q);
    const [total, items, booked, settlements, sold, installmentAccounts] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: {
          account: {
            select: {
              id: true,
              publicCode: true,
              price: true,
              contributed: true,
              dueAt: true,
              gameUser: true,
              gamePass: true,
              shopCategory: { select: { code: true, title: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.order.findMany({
        where: {
          status: { in: ['PAID', 'INSTALLMENT', 'ABANDONED'] },
          ...(createdInMonth ? { createdAt: createdInMonth } : {}),
        },
        select: {
          amount: true,
          status: true,
          settlementAmount: true,
          account: { select: { contributed: true, price: true, cost: true, profit: true, consignment: true } },
        },
      }),
      this.prisma.order.findMany({
        where: {
          status: 'PAID',
          settlementAmount: { not: null },
          paidAt: createdInMonth ?? { not: null },
          account: { consignment: false },
        },
        select: { settlementAmount: true },
      }),
      this.prisma.order.findMany({
        where: {
          status: 'PAID',
          paidAt: createdInMonth ?? { not: null },
        },
        select: { id: true },
      }),
      this.prisma.account.findMany({
        where: { status: 'RESERVED' },
        select: { price: true, contributed: true },
      }),
    ]);
    let revenue = 0;
    let received = 0;
    let profit = 0;
    for (const order of booked) {
      if (order.status === 'ABANDONED') {
        const paid = order.settlementAmount ?? 0;
        revenue += paid;
        profit += paid;
        received += paid;
        continue;
      }
      if (order.account.consignment) {
        profit += order.account.profit;
        received += order.account.profit;
        continue;
      }
      revenue += order.amount;
      profit += order.account.profit;
      if (order.status === 'PAID') {
        received += order.settlementAmount == null ? order.amount : order.amount - order.settlementAmount;
      } else received += Math.min(Math.max(order.account.contributed, 0), order.account.price);
    }
    for (const order of settlements) received += order.settlementAmount ?? 0;
    const remainingInstallment = installmentAccounts.reduce((sum, account) => {
      const paid = Math.min(Math.max(account.contributed, 0), account.price);
      return sum + (account.price - paid);
    }, 0);
    return {
      month,
      mailConfigured: this.mail.configured,
      dueSoon,
      items: items.map((order) => {
        const paid = Math.min(Math.max(order.account.contributed, 0), order.account.price);
        const installment = order.status === 'INSTALLMENT';
        return {
          id: order.id,
          code: order.code,
          buyerName: order.buyerName,
          phone: order.phone,
          email: order.email,
          amount: order.status === 'ABANDONED' ? (order.settlementAmount ?? order.amount) : order.amount,
          remaining: installment ? order.account.price - paid : null,
          status: order.status,
          createdAt: order.createdAt,
          paidAt: order.paidAt,
          reclaimed: order.reclaimed,
          dueAt: installment ? order.account.dueAt : null,
          daysLeft: installment && order.account.dueAt ? daysUntil(order.account.dueAt) : null,
          accountId: order.account.id,
          accountCode: order.account.publicCode,
          gameUser: order.account.gameUser,
          gamePass: order.account.gamePass,
          category: order.account.shopCategory.code,
          categoryTitle: order.account.shopCategory.title,
        };
      }),
      total,
      page,
      pageSize,
      stats: {
        revenue,
        soldAccounts: sold.length,
        installmentAccounts: installmentAccounts.length,
        remainingInstallment,
        received,
        profit,
      },
    };
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, select: { id: true, code: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    await this.prisma.order.delete({ where: { id } });
    return { ok: true, code: order.code };
  }

  @Post(':id/settle')
  async settle(@Param('id') id: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { account: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== 'INSTALLMENT' || order.account.status !== 'RESERVED') {
      throw new BadRequestException('Chỉ tất toán được đơn đang góp');
    }
    const now = new Date();
    const paid = Math.min(Math.max(order.account.contributed, 0), order.account.price);
    const remaining = order.account.price - paid;
    await this.prisma.$transaction([
      this.prisma.account.update({
        where: { id: order.accountId },
        data: { status: 'SOLD', contributed: order.account.price },
      }),
      this.prisma.order.update({
        where: { id },
        data: {
          status: 'PAID',
          paidAt: now,
          amount: order.account.price,
          settlementAmount: remaining,
        },
      }),
    ]);
    return { ok: true };
  }

  @Post(':id/reclaim')
  async reclaim(@Param('id') id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { account: { include: { images: true } } },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== 'PAID' && order.status !== 'INSTALLMENT') {
      throw new BadRequestException('Chỉ thu lại được đơn đã bán hoặc đang góp');
    }
    const source = order.account;
    if (order.status === 'INSTALLMENT') {
      const paid = Math.min(Math.max(source.contributed, 0), source.price);
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'ABANDONED', amount: paid, settlementAmount: paid, reclaimed: true },
      });
      await this.prisma.account.update({
        where: { id: source.id },
        data: { status: 'HIDDEN' },
      });
    } else {
      await this.prisma.order.update({ where: { id: order.id }, data: { reclaimed: true } });
    }
    const created = await this.prisma.account.create({
      data: {
        categoryId: source.categoryId,
        price: source.price,
        description: source.description,
        specs: source.specs ?? {},
        gameUser: source.gameUser,
        gamePass: source.gamePass,
        status: 'AVAILABLE',
        cost: source.cost,
        profit: source.profit,
        consignment: source.consignment,
        images: {
          create: source.images.map((image) => ({
            key: image.key,
            url: image.url,
            sortOrder: image.sortOrder,
            isCover: image.isCover,
          })),
        },
      },
      select: { id: true, publicCode: true },
    });
    return { id: created.id, publicCode: created.publicCode };
  }

  private whereFor(createdInMonth: { gte: Date; lt: Date } | undefined, raw?: string): Prisma.OrderWhereInput {
    const filters: Prisma.OrderWhereInput[] = [
      // Đơn đang chờ / hết hạn thanh toán QR không hiện trong list bán hàng
      { status: { in: ['PAID', 'INSTALLMENT', 'ABANDONED'] } },
    ];
    if (createdInMonth) filters.push({ createdAt: createdInMonth });
    const keyword = raw?.trim();
    if (keyword) {
      const codeNumber = Number(keyword.replace(/^#/, ''));
      const or: Prisma.OrderWhereInput[] = [
        { code: { contains: keyword, mode: 'insensitive' } },
        { buyerName: { contains: keyword, mode: 'insensitive' } },
        { email: { contains: keyword, mode: 'insensitive' } },
        { phone: { contains: keyword } },
        { account: { gameUser: { contains: keyword, mode: 'insensitive' } } },
        { account: { buyerName: { contains: keyword, mode: 'insensitive' } } },
      ];
      if (Number.isInteger(codeNumber) && codeNumber > 0) or.push({ account: { publicCode: codeNumber } });
      filters.push({ OR: or });
    }
    return { AND: filters };
  }

  private async backfillSaleOrders() {
    // Chỉ tạo đơn DH- cho acc cũ chưa từng có Order (không tái tạo sau khi admin xóa).
    const accounts = await this.prisma.account.findMany({
      where: {
        status: { in: ['SOLD', 'RESERVED'] },
        orders: { none: {} },
      },
    });
    for (const account of accounts) {
      const dueAt = account.dueAt ?? new Date(account.updatedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      await this.prisma.order.create({
        data: {
          code: `DH-${account.publicCode}`,
          accountId: account.id,
          phone: account.buyerPhone,
          email: account.buyerEmail || null,
          buyerName: account.buyerName,
          amount: account.price,
          status: account.status === 'SOLD' ? 'PAID' : 'INSTALLMENT',
          paidAt: account.status === 'SOLD' ? account.updatedAt : null,
          expiresAt: dueAt,
          createdAt: account.updatedAt,
        },
      });
    }
  }
}
