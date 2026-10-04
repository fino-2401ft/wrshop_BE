import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

type DemoAccount = {
  category: string;
  price: number;
  description: string;
  gameUser: string;
  gamePass: string;
  color: string;
  specs: Record<string, string>;
};

const DEMOS: DemoAccount[] = [
  {
    category: 'VIP',
    price: 14000000,
    description: 'Acc VIP nhiều tướng và skin, ảnh chụp đầy đủ hồ sơ.',
    gameUser: 'demo_vip_1',
    gamePass: 'DemoPass1',
    color: '#7c3aed',
    specs: {
      heroes: '128',
      skins: '343',
      seasons: '17',
      level: '229',
      rank: 'Cao Thủ',
      frame: 'Thách Đấu',
      rankHt: 'Tướng Soái',
      frameHt: 'Tướng Soái',
    },
  },
  {
    category: 'VIP',
    price: 5000000,
    description: 'Acc VIP rank Bạch Kim, khung Kim Cương.',
    gameUser: 'demo_vip_2',
    gamePass: 'DemoPass2',
    color: '#db2777',
    specs: {
      heroes: '102',
      skins: '154',
      seasons: '22',
      level: '129',
      rank: 'Bạch Kim',
      frame: 'Kim Cương',
      rankHt: 'Không có',
      frameHt: 'Không có',
    },
  },
  {
    category: 'NGON',
    price: 2500000,
    description: 'Acc ngon, đủ tướng meta.',
    gameUser: 'demo_ngon_1',
    gamePass: 'DemoPass3',
    color: '#059669',
    specs: {
      heroes: '86',
      skins: '120',
      seasons: '15',
      level: '98',
      rank: 'Kim Cương',
      frame: 'Cao Thủ',
      rankHt: 'Vệ Binh',
      frameHt: 'Vệ Binh',
    },
  },
  {
    category: 'NGON',
    price: 1500000,
    description: 'Acc ngon giá vừa, level cao.',
    gameUser: 'demo_ngon_2',
    gamePass: 'DemoPass4',
    color: '#0f766e',
    specs: {
      heroes: '74',
      skins: '96',
      seasons: '12',
      level: '140',
      rank: 'Vàng',
      frame: 'Bạch Kim',
      rankHt: 'Không có',
      frameHt: 'Không có',
    },
  },
  {
    category: 'GIA_RE',
    price: 500000,
    description: 'Acc giá rẻ để tập chơi.',
    gameUser: 'demo_re_1',
    gamePass: 'DemoPass5',
    color: '#0284c7',
    specs: {
      heroes: '42',
      skins: '30',
      seasons: '8',
      level: '40',
      rank: 'Bạc',
      frame: 'Vàng',
      rankHt: 'Không có',
      frameHt: 'Không có',
    },
  },
  {
    category: 'GIA_RE',
    price: 200000,
    description: 'Acc giá rẻ, ít skin.',
    gameUser: 'demo_re_2',
    gamePass: 'DemoPass6',
    color: '#0369a1',
    specs: {
      heroes: '28',
      skins: '12',
      seasons: '4',
      level: '22',
      rank: 'Đồng',
      frame: 'Bạc',
      rankHt: 'Không có',
      frameHt: 'Không có',
    },
  },
];

function svg(title: string, subtitle: string, color: string, height: number) {
  const esc = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="${height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${color}"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="${height}" fill="url(#g)"/>
  <text x="72" y="140" fill="#ffffff" font-size="54" font-family="Arial, sans-serif">${esc(title)}</text>
  <text x="72" y="220" fill="#fde68a" font-size="36" font-family="Arial, sans-serif">${esc(subtitle)}</text>
  <text x="72" y="${height - 80}" fill="#cbd5e1" font-size="28" font-family="Arial, sans-serif">Ảnh minh họa — thay bằng ảnh acc thật trong trang quản trị</text>
</svg>`);
}

@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
  ) {}

  async onApplicationBootstrap() {
    await this.ensureAdmin();
    await this.ensureCategories();
    if (this.config.get<string>('SEED_DEMO') === 'true') {
      await this.seedDemo();
    }
  }

  private async ensureAdmin() {
    const existing = await this.prisma.admin.findFirst();
    if (existing) return;
    const username = this.config.get<string>('ADMIN_USERNAME')?.trim();
    const password = this.config.get<string>('ADMIN_PASSWORD') ?? '';
    if (!username || !password) {
      this.logger.warn('Chưa có admin. Đặt ADMIN_USERNAME và ADMIN_PASSWORD trong api/.env');
      return;
    }
    await this.prisma.admin.create({
      data: { username, passwordHash: await bcrypt.hash(password, 10) },
    });
    this.logger.log(`Đã tạo admin "${username}"`);
  }

  private async ensureCategories() {
    const defaults = [
      { id: 'cat_vip', code: 'VIP', slug: 'vip', title: 'PREMIUM ACCOUNT', sortOrder: 0 },
      { id: 'cat_ngon', code: 'NGON', slug: 'ngon', title: 'VIP ACCOUNT', sortOrder: 1 },
      { id: 'cat_re', code: 'GIA_RE', slug: 'gia-re', title: 'CHEAP ACCOUNT', sortOrder: 2 },
    ];
    for (const item of defaults) {
      await this.prisma.shopCategory.upsert({
        where: { code: item.code },
        update: {},
        create: item,
      });
    }
  }

  private async seedDemo() {
    const count = await this.prisma.account.count();
    if (count > 0) return;
    for (const demo of DEMOS) {
      const category = await this.prisma.shopCategory.findUnique({ where: { code: demo.category } });
      if (!category) continue;
      const account = await this.prisma.account.create({
        data: {
          categoryId: category.id,
          price: demo.price,
          description: demo.description,
          specs: demo.specs,
          gameUser: demo.gameUser,
          gamePass: demo.gamePass,
          status: 'AVAILABLE',
        },
      });
      const files = [
        {
          buffer: svg(demo.category, `${demo.price.toLocaleString('vi-VN')} đ`, demo.color, 720),
          mime: 'image/svg+xml',
        },
        {
          buffer: svg('Hình ảnh tài khoản', demo.description, demo.color, 1400),
          mime: 'image/svg+xml',
        },
      ];
      for (const [index, file] of files.entries()) {
        const uploaded = await this.storage.upload(account.id, file.buffer, file.mime);
        await this.prisma.accountImage.create({
          data: {
            accountId: account.id,
            key: uploaded.key,
            url: uploaded.url,
            sortOrder: index,
            isCover: index === 0,
          },
        });
      }
    }
    this.logger.log('Đã tạo 6 acc minh họa');
  }
}
