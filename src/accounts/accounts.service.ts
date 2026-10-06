import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountImage, AccountStatus, Prisma } from '@prisma/client';
import { addDays, parseDueDate, vnDateKey } from '../common/vn-date';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  AdminListQuery,
  CreateAccountDto,
  ListAccountsQuery,
  UpdateAccountDto,
  cleanSpecs,
} from './dto';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const WITH_CATEGORY = { images: true, shopCategory: true } as const;
type AccountWithImages = Prisma.AccountGetPayload<{ include: typeof WITH_CATEGORY }>;

const DEFAULT_CATEGORIES = [
  { id: 'cat_vip', code: 'VIP', slug: 'vip', title: 'PREMIUM ACCOUNT', sortOrder: 0 },
  { id: 'cat_ngon', code: 'NGON', slug: 'ngon', title: 'VIP ACCOUNT', sortOrder: 1 },
  { id: 'cat_re', code: 'GIA_RE', slug: 'gia-re', title: 'CHEAP ACCOUNT', sortOrder: 2 },
];

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async home() {
    const categories = await this.prisma.shopCategory.findMany({ orderBy: { sortOrder: 'asc' } });
    const groups = await Promise.all(
      categories.map(async (category) => {
        const rows = await this.prisma.account.findMany({
          where: { categoryId: category.id, status: 'AVAILABLE' },
          include: WITH_CATEGORY,
          orderBy: { createdAt: 'desc' },
        });
        return {
          category: category.code,
          slug: category.slug,
          title: category.title,
          accounts: rows.map((row) => this.toCard(row)),
        };
      }),
    );
    return { categories: groups };
  }

  async listCategories() {
    return this.prisma.shopCategory.findMany({
      orderBy: { sortOrder: 'asc' },
      select: { id: true, code: true, slug: true, title: true },
    });
  }

  async listCategoriesAdmin() {
    const rows = await this.prisma.shopCategory.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { accounts: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      slug: row.slug,
      title: row.title,
      accountCount: row._count.accounts,
      locked: DEFAULT_CATEGORIES.some((item) => item.code === row.code),
    }));
  }

  async createCategory(title: string) {
    const name = title.trim();
    const base = slugify(name);
    if (base.length < 2) throw new BadRequestException('Tên danh mục không hợp lệ');
    const existing = await this.prisma.shopCategory.findMany({ select: { slug: true, sortOrder: true } });
    const taken = new Set(existing.map((item) => item.slug));
    let slug = base;
    let suffix = 2;
    while (taken.has(slug)) slug = `${base}-${suffix++}`;
    const sortOrder = existing.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1;
    return this.prisma.shopCategory.create({
      data: { code: slug, slug, title: name, sortOrder },
      select: { id: true, code: true, slug: true, title: true },
    });
  }

  async removeCategory(id: string) {
    const category = await this.prisma.shopCategory.findUnique({ where: { id } });
    if (!category) throw new NotFoundException('Không tìm thấy danh mục');
    if (DEFAULT_CATEGORIES.some((item) => item.code === category.code)) {
      throw new BadRequestException('Không xóa danh mục mặc định');
    }
    const accountCount = await this.prisma.account.count({ where: { categoryId: id } });
    if (accountCount > 0) throw new BadRequestException('Danh mục còn acc, không xóa được');
    await this.prisma.shopCategory.delete({ where: { id } });
    return { ok: true };
  }

  async listPublic(query: ListAccountsQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 8;
    const where = await this.publicWhere(query);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.account.count({ where }),
      this.prisma.account.findMany({
        where,
        include: WITH_CATEGORY,
        orderBy: this.orderBy(query.sort),
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: rows.map((row) => this.toCard(row)),
      total,
      page,
      pageSize,
    };
  }

  async getPublic(publicCode: number) {
    const account = await this.prisma.account.findUnique({
      where: { publicCode },
      include: { images: { orderBy: { sortOrder: 'asc' } }, shopCategory: true },
    });
    if (!account || account.status === 'HIDDEN') {
      throw new NotFoundException('Không tìm thấy acc');
    }
    return this.toDetail(account);
  }

  async listAdmin(query: AdminListQuery) {
    const page = query.page ?? 1;
    const pageSize = 20;
    const where: Prisma.AccountWhereInput = {};
    if (query.category) where.categoryId = (await this.categoryIdOf(query.category)) ?? '__missing__';
    if (query.status) where.status = query.status;
    const keyword = query.code?.trim();
    if (keyword) {
      const code = this.parseCode(keyword);
      const or: Prisma.AccountWhereInput[] = [{ gameUser: { contains: keyword.replace(/^#/, ''), mode: 'insensitive' } }];
      if (code && code > 0) or.push({ publicCode: code });
      where.OR = or;
    }
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.account.count({ where }),
      this.prisma.account.findMany({
        where,
        include: { ...WITH_CATEGORY, _count: { select: { images: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: rows.map((row) => ({
        ...this.toCard(row),
        gameUser: row.gameUser,
        gamePass: row.gamePass,
        imageCount: row._count.images,
      })),
      total,
      page,
      pageSize,
    };
  }

  async getAdmin(id: string) {
    const account = await this.prisma.account.findUnique({
      where: { id },
      include: {
        images: { orderBy: { sortOrder: 'asc' } },
        shopCategory: true,
        orders: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!account) throw new NotFoundException('Không tìm thấy acc');
    return {
      ...this.toDetail(account),
      gameUser: account.gameUser,
      gamePass: account.gamePass,
      contributed: account.contributed,
      buyerName: account.buyerName,
      buyerEmail: account.buyerEmail,
      buyerPhone: account.buyerPhone,
      cost: account.cost,
      profit: account.profit,
      consignment: account.consignment,
      dueAt: account.dueAt,
      orders: account.orders.map((order) => ({
        id: order.id,
        code: order.code,
        buyerName: order.buyerName,
        phone: order.phone,
        email: order.email,
        amount: order.amount,
        status: order.status,
        createdAt: order.createdAt,
      })),
      images: account.images.map((image) => ({
        id: image.id,
        url: this.storage.publicUrl(image.url) ?? image.url,
        key: image.key,
        sortOrder: image.sortOrder,
        isCover: image.isCover,
      })),
    };
  }

  async create(dto: CreateAccountDto) {
    const categoryId = await this.categoryIdOf(this.categoryCodeForPrice(dto.price));
    if (!categoryId) throw new BadRequestException('Danh mục không tồn tại');
    const account = await this.prisma.account.create({
      data: {
        categoryId,
        price: dto.price,
        description: dto.description?.trim() ?? '',
        specs: cleanSpecs(dto.specs),
        gameUser: dto.gameUser.trim(),
        gamePass: dto.gamePass,
        status: dto.status ?? 'AVAILABLE',
        contributed: this.contributedAmount(dto.contributed ?? 0, dto.price),
        buyerName: this.cleanBuyer(dto.buyerName),
        buyerEmail: this.cleanEmail(dto.buyerEmail),
        buyerPhone: this.cleanBuyer(dto.buyerPhone),
        cost: this.contributedAmount(dto.cost ?? 0, 1_000_000_000),
        profit: this.profitAmount(dto.profit ?? dto.price - (dto.cost ?? 0)),
        consignment: dto.consignment ?? false,
        ...this.dueData(null, dto.status ?? 'AVAILABLE', dto.dueAt),
      },
    });
    await this.syncSaleOrder(account.id);
    return this.getAdmin(account.id);
  }

  async update(id: string, dto: UpdateAccountDto) {
    await this.ensure(id);
    const current = await this.prisma.account.findUnique({
      where: { id },
      select: { price: true, contributed: true, status: true, dueAt: true },
    });
    const data: Prisma.AccountUncheckedUpdateInput = {};
    const price = dto.price ?? current?.price ?? 0;
    const categoryId = await this.categoryIdOf(this.categoryCodeForPrice(price));
    if (!categoryId) throw new BadRequestException('Danh mục không tồn tại');
    data.categoryId = categoryId;
    if (dto.price !== undefined) data.price = dto.price;
    if (dto.description !== undefined) data.description = dto.description.trim();
    if (dto.gameUser !== undefined) data.gameUser = dto.gameUser.trim();
    if (dto.gamePass !== undefined) data.gamePass = dto.gamePass;
    if (dto.status) data.status = dto.status;
    if (dto.contributed !== undefined || dto.price !== undefined) {
      const price = dto.price ?? current?.price ?? 0;
      const contributed = dto.contributed ?? current?.contributed ?? 0;
      data.contributed = this.contributedAmount(contributed, price);
    }
    if (dto.buyerName !== undefined) data.buyerName = this.cleanBuyer(dto.buyerName);
    if (dto.buyerEmail !== undefined) data.buyerEmail = this.cleanEmail(dto.buyerEmail);
    if (dto.buyerPhone !== undefined) data.buyerPhone = this.cleanBuyer(dto.buyerPhone);
    if (dto.cost !== undefined) data.cost = this.contributedAmount(dto.cost, 1_000_000_000);
    if (dto.profit !== undefined) data.profit = this.profitAmount(dto.profit);
    if (dto.consignment !== undefined) data.consignment = dto.consignment;
    const nextStatus = dto.status ?? current?.status ?? 'AVAILABLE';
    if (nextStatus === 'RESERVED') Object.assign(data, this.dueData(current ?? null, nextStatus, dto.dueAt));
    if (dto.specs) data.specs = cleanSpecs(dto.specs);
    await this.prisma.account.update({ where: { id }, data });
    await this.syncSaleOrder(id);
    return this.getAdmin(id);
  }

  async remove(id: string) {
    const account = await this.prisma.account.findUnique({
      where: { id },
      include: { images: true },
    });
    if (!account) throw new NotFoundException('Không tìm thấy acc');
    try {
      await this.prisma.account.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new BadRequestException('Acc đã có đơn hàng. Hãy chuyển trạng thái sang Ẩn');
      }
      throw error;
    }
    await Promise.all(account.images.map((image) => this.removeStoredFile(image.key)));
    return { ok: true };
  }

  async addImages(id: string, files: Express.Multer.File[], kind: string) {
    await this.ensure(id);
    if (kind !== 'cover' && kind !== 'gallery') {
      throw new BadRequestException('Chọn loại ảnh: ảnh bìa hoặc ảnh acc');
    }
    if (!files?.length) throw new BadRequestException('Chọn ít nhất một ảnh');
    for (const file of files) this.assertImage(file);

    if (kind === 'cover') {
      if (files.length !== 1) throw new BadRequestException('Ảnh bìa chỉ nhận 1 ảnh');
      const previous = await this.prisma.accountImage.findMany({
        where: { accountId: id, isCover: true },
      });
      const uploaded = await this.storage.upload(id, files[0].buffer, files[0].mimetype);
      await this.prisma.accountImage.create({
        data: {
          accountId: id,
          key: uploaded.key,
          url: uploaded.url,
          sortOrder: 0,
          isCover: true,
        },
      });
      await Promise.all(previous.map((image) => this.deleteStoredImage(image)));
      return this.getAdmin(id);
    }

    const galleryCount = await this.prisma.accountImage.count({
      where: { accountId: id, isCover: false },
    });
    if (galleryCount + files.length > 20) {
      throw new BadRequestException('Mỗi acc tối đa 20 ảnh chi tiết');
    }
    const maxSort = await this.prisma.accountImage.aggregate({
      where: { accountId: id, isCover: false },
      _max: { sortOrder: true },
    });
    let sort = (maxSort._max.sortOrder ?? -1) + 1;
    for (const file of files) {
      const uploaded = await this.storage.upload(id, file.buffer, file.mimetype);
      await this.prisma.accountImage.create({
        data: {
          accountId: id,
          key: uploaded.key,
          url: uploaded.url,
          sortOrder: sort,
          isCover: false,
        },
      });
      sort += 1;
    }
    return this.getAdmin(id);
  }

  async reorderImages(id: string, ids: string[]) {
    await this.ensure(id);
    const images = await this.prisma.accountImage.findMany({
      where: { accountId: id, isCover: false },
    });
    if (images.length !== ids.length || images.some((image) => !ids.includes(image.id))) {
      throw new BadRequestException('Danh sách ảnh acc không khớp');
    }
    await this.prisma.$transaction(
      ids.map((imageId, index) =>
        this.prisma.accountImage.update({
          where: { id: imageId },
          data: { sortOrder: index, isCover: false },
        }),
      ),
    );
    return this.getAdmin(id);
  }

  async removeImage(accountId: string, imageId: string) {
    const image = await this.prisma.accountImage.findFirst({ where: { id: imageId, accountId } });
    if (!image) throw new NotFoundException('Không tìm thấy ảnh');
    await this.deleteStoredImage(image);
    return this.getAdmin(accountId);
  }

  private async ensure(id: string) {
    const found = await this.prisma.account.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new NotFoundException('Không tìm thấy acc');
  }

  private cleanBuyer(value?: string) {
    return value?.trim() ?? '';
  }

  private cleanEmail(value?: string) {
    const email = value?.trim() ?? '';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Email không hợp lệ');
    }
    return email;
  }

  private async syncSaleOrder(id: string) {
    const account = await this.prisma.account.findUnique({ where: { id } });
    if (!account) return;
    const code = `DH-${account.publicCode}`;
    const existing = await this.prisma.order.findUnique({ where: { code } });
    if (existing?.status === 'ABANDONED') return;
    const selling = account.status === 'SOLD' || account.status === 'RESERVED';
    if (!selling) {
      if (existing && !existing.paidTransactionId) {
        await this.prisma.order.delete({ where: { id: existing.id } });
      }
      return;
    }
    let dueAt = account.dueAt;
    if (account.status === 'RESERVED' && !dueAt) {
      dueAt = addDays(new Date(), 30);
      await this.prisma.account.update({ where: { id }, data: { dueAt } });
    }
    const data = {
      phone: account.buyerPhone,
      email: account.buyerEmail || null,
      buyerName: account.buyerName,
      amount: account.price,
      status: account.status === 'SOLD' ? ('PAID' as const) : ('INSTALLMENT' as const),
      paidAt: account.status === 'SOLD' ? existing?.paidAt ?? new Date() : null,
      expiresAt: dueAt ?? existing?.expiresAt ?? addDays(new Date(), 30),
      settlementAmount: account.status === 'SOLD' ? existing?.settlementAmount ?? null : null,
    };
    if (existing) {
      await this.prisma.order.update({ where: { id: existing.id }, data });
      return;
    }
    await this.prisma.order.create({
      data: { code, accountId: account.id, ...data },
    });
  }

  private dueData(
    current: { status: AccountStatus; dueAt: Date | null } | null,
    status: AccountStatus,
    dueAt?: string,
  ): { dueAt: Date; reminded3dAt?: null; remindedDueAt?: null } | Record<string, never> {
    if (status !== 'RESERVED') return {};
    const parsed = dueAt ? parseDueDate(dueAt) : null;
    if (dueAt && !parsed) throw new BadRequestException('Hạn tất toán không hợp lệ');
    const becoming = !current || current.status !== 'RESERVED';
    const next = parsed ?? (becoming || !current?.dueAt ? addDays(new Date(), 30) : current.dueAt);
    const changed = !current?.dueAt || vnDateKey(current.dueAt) !== vnDateKey(next);
    return changed ? { dueAt: next, reminded3dAt: null, remindedDueAt: null } : { dueAt: next };
  }

  private profitAmount(value: number) {
    if (!Number.isInteger(value) || value < -1_000_000_000 || value > 1_000_000_000) {
      throw new BadRequestException('Lợi nhuận không hợp lệ');
    }
    return value;
  }

  private contributedAmount(value: number, price: number) {
    if (!Number.isInteger(value) || value < 0) {
      throw new BadRequestException('Số tiền đã góp không hợp lệ');
    }
    if (value > price) {
      throw new BadRequestException('Số tiền đã góp không được lớn hơn giá acc');
    }
    return value;
  }

  private categoryCodeForPrice(price: number) {
    if (price >= 5_000_000) return 'VIP';
    if (price >= 1_000_000) return 'NGON';
    return 'GIA_RE';
  }

  private async categoryIdOf(key: string) {
    const found = await this.prisma.shopCategory.findFirst({
      where: { OR: [{ code: key }, { slug: key }] },
      select: { id: true },
    });
    return found?.id;
  }

  private async publicWhere(query: ListAccountsQuery): Promise<Prisma.AccountWhereInput> {
    const where: Prisma.AccountWhereInput = { status: 'AVAILABLE' };
    if (query.category) where.categoryId = (await this.categoryIdOf(query.category)) ?? '__missing__';
    const code = this.parseCode(query.code);
    if (code) where.publicCode = code;
    if (query.rank?.trim()) {
      where.specs = { path: ['rank'], equals: query.rank.trim() };
    }
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      where.price = {};
      if (query.minPrice !== undefined) where.price.gte = query.minPrice;
      if (query.maxPrice !== undefined) where.price.lte = query.maxPrice;
    }
    return where;
  }

  private orderBy(sort?: ListAccountsQuery['sort']): Prisma.AccountOrderByWithRelationInput {
    if (sort === 'price_asc') return { price: 'asc' };
    if (sort === 'price_desc') return { price: 'desc' };
    return { createdAt: 'desc' };
  }

  private parseCode(raw?: string) {
    if (!raw?.trim()) return undefined;
    const value = Number(raw.trim().replace(/^#/, ''));
    return Number.isInteger(value) && value > 0 ? value : -1;
  }

  private assertImage(file: Express.Multer.File) {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException('Chỉ nhận ảnh JPG, PNG, WEBP hoặc GIF');
    }
  }

  private async deleteStoredImage(image: AccountImage) {
    await this.prisma.accountImage.delete({ where: { id: image.id } });
    await this.removeStoredFile(image.key);
  }

  private async removeStoredFile(key: string) {
    const stillUsed = await this.prisma.accountImage.count({ where: { key } });
    if (stillUsed === 0) await this.storage.remove(key).catch(() => undefined);
  }

  private coverOf(images: AccountImage[]) {
    return images.find((image) => image.isCover) ?? null;
  }

  private toCard(account: AccountWithImages) {
    const cover = this.coverOf(account.images);
    return {
      id: account.id,
      publicCode: account.publicCode,
      category: account.shopCategory.code,
      categoryTitle: account.shopCategory.title,
      categorySlug: account.shopCategory.slug,
      price: account.price,
      description: account.description,
      specs: account.specs,
      status: account.status as AccountStatus,
      coverUrl: this.storage.publicUrl(cover?.url ?? null),
      createdAt: account.createdAt,
    };
  }

  private toDetail(account: AccountWithImages) {
    const images = [...account.images]
      .filter((image) => !image.isCover)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return {
      ...this.toCard(account),
      images: images.map((image) => ({
        id: image.id,
        url: this.storage.publicUrl(image.url) ?? image.url,
        sortOrder: image.sortOrder,
        isCover: image.isCover,
      })),
    };
  }
}

function slugify(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
