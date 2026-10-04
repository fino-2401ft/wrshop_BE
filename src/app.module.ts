import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';
import { AuthModule } from './auth/auth.module';
import { AccountsModule } from './accounts/accounts.module';
import { OrdersModule } from './orders/orders.module';
import { BootstrapService } from './bootstrap/bootstrap.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    StorageModule,
    AuthModule,
    AccountsModule,
    OrdersModule,
  ],
  providers: [BootstrapService],
})
export class AppModule {}
