import { AccountStatus, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class SpecsDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  heroes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  skins?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  rank?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  frame?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  rankHt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  frameHt?: string;
}

export class CreateAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  category!: string;

  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  price!: number;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  gameUser!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  gamePass!: string;

  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  contributed?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  buyerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  buyerEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  buyerPhone?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  cost?: number;

  @IsOptional()
  @IsInt()
  @Min(-1_000_000_000)
  @Max(1_000_000_000)
  profit?: number;

  @IsOptional()
  @IsBoolean()
  consignment?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dueAt?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SpecsDto)
  specs?: SpecsDto;
}

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  price?: number;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  gameUser?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  gamePass?: string;

  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  contributed?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  buyerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  buyerEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  buyerPhone?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  cost?: number;

  @IsOptional()
  @IsInt()
  @Min(-1_000_000_000)
  @Max(1_000_000_000)
  profit?: number;

  @IsOptional()
  @IsBoolean()
  consignment?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dueAt?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SpecsDto)
  specs?: SpecsDto;
}

export class ListAccountsQuery {
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  rank?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPrice?: number;

  @IsOptional()
  @IsIn(['newest', 'price_asc', 'price_desc'])
  sort?: 'newest' | 'price_asc' | 'price_desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  pageSize?: number;
}

export class AdminListQuery {
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

export class CreateCategoryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  title!: string;
}

export class ReorderImagesDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  ids!: string[];
}

export function cleanSpecs(input?: SpecsDto): Prisma.InputJsonObject {
  const pick = (value?: string) => (typeof value === 'string' ? value.trim() : '');
  return {
    heroes: pick(input?.heroes),
    skins: pick(input?.skins),
    rank: pick(input?.rank),
    frame: pick(input?.frame),
    rankHt: pick(input?.rankHt),
    frameHt: pick(input?.frameHt),
  };
}
