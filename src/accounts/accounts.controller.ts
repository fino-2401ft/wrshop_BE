import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { ListAccountsQuery } from './dto';

@Controller('api/accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get('home')
  home() {
    return this.accounts.home();
  }

  @Get('categories')
  categories() {
    return this.accounts.listCategories();
  }

  @Get()
  list(@Query() query: ListAccountsQuery) {
    return this.accounts.listPublic(query);
  }

  @Get(':code')
  getOne(@Param('code', ParseIntPipe) code: number) {
    return this.accounts.getPublic(code);
  }
}
