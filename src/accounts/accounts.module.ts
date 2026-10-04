import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { AdminAccountsController } from './admin-accounts.controller';
import { AdminCategoriesController } from './admin-categories.controller';
import { AccountsService } from './accounts.service';

@Module({
  controllers: [AccountsController, AdminAccountsController, AdminCategoriesController],
  providers: [AccountsService],
})
export class AccountsModule {}
