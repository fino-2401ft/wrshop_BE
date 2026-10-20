import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AccountsService } from './accounts.service';
import { AdminListQuery, CreateAccountDto, ReorderImagesDto, UpdateAccountDto } from './dto';

@Controller('api/admin/accounts')
@UseGuards(JwtAuthGuard)
export class AdminAccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  list(@Query() query: AdminListQuery) {
    return this.accounts.listAdmin(query);
  }

  @Get('export/selling')
  async exportSelling(@Res() res: Response) {
    const csv = await this.accounts.exportSellingCsv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="acc-dang-ban.csv"');
    res.send(csv);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.accounts.getAdmin(id);
  }

  @Post()
  create(@Body() dto: CreateAccountDto) {
    return this.accounts.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAccountDto) {
    return this.accounts.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.accounts.remove(id);
  }

  @Post(':id/images')
  @UseInterceptors(FilesInterceptor('files', 20, { limits: { fileSize: 8 * 1024 * 1024 } }))
  addImages(
    @Param('id') id: string,
    @Query('kind') kind: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.accounts.addImages(id, files, kind);
  }

  @Patch(':id/images/order')
  reorder(@Param('id') id: string, @Body() dto: ReorderImagesDto) {
    return this.accounts.reorderImages(id, dto.ids);
  }

  @Delete(':id/images/:imageId')
  removeImage(@Param('id') id: string, @Param('imageId') imageId: string) {
    return this.accounts.removeImage(id, imageId);
  }
}
