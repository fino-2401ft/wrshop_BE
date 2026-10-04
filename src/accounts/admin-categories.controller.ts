import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AccountsService } from './accounts.service';
import { CreateCategoryDto } from './dto';

@Controller('api/admin/categories')
@UseGuards(JwtAuthGuard)
export class AdminCategoriesController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  list() {
    return this.accounts.listCategoriesAdmin();
  }

  @Post()
  create(@Body() dto: CreateCategoryDto) {
    return this.accounts.createCategory(dto.title);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.accounts.removeCategory(id);
  }
}
