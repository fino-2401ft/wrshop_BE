import { Transform, Type } from 'class-transformer';
import { IsEmail, IsInt, Matches, MaxLength, Min, MinLength } from 'class-validator';

export class CheckoutDto {
  @Type(() => Number)
  @IsInt({ message: 'Mã acc không hợp lệ' })
  @Min(1, { message: 'Mã acc không hợp lệ' })
  publicCode!: number;

  @Transform(({ value }) => String(value ?? '').trim().replace(/\s+/g, ' '))
  @MinLength(2, { message: 'Nhập họ tên' })
  @MaxLength(80, { message: 'Họ tên quá dài' })
  buyerName!: string;

  @Transform(({ value }) =>
    String(value ?? '')
      .replace(/[^\d+]/g, '')
      .replace(/^\+84/, '0')
      .replace(/^84/, '0'),
  )
  @Matches(/^0(3|5|7|8|9)\d{8}$/, { message: 'Số Zalo không hợp lệ' })
  phone!: string;

  @Transform(({ value }) => String(value ?? '').trim().toLowerCase())
  @IsEmail({}, { message: 'Email không hợp lệ' })
  @MaxLength(120, { message: 'Email không hợp lệ' })
  email!: string;
}
