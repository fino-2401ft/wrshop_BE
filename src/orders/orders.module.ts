import { Module } from '@nestjs/common';
import { AdminOrdersController } from './admin-orders.controller';
import { InstallmentReminderService } from './installment-reminder.service';
import { MailService } from './mail.service';

@Module({
  controllers: [AdminOrdersController],
  providers: [MailService, InstallmentReminderService],
})
export class OrdersModule {}
