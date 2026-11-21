import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ConsigneeDto {
  @IsString() @MinLength(2) name: string;
  @IsString() @MinLength(7) phone: string;
  @IsOptional() @IsString() phone2?: string;
  @IsOptional() @IsString() email?: string;
  @IsString() @MinLength(5) address: string;
  @IsString() @MinLength(2) city: string;
}

export class BookShipmentDto {
  @IsString() courier: string; // POSTEX | LEOPARDS | TCS
  @IsOptional() @IsString() accountId?: string;
  @IsString() @MinLength(1) orderRef: string;
  @ValidateNested() @Type(() => ConsigneeDto) consignee: ConsigneeDto;
  @IsInt() @Min(0) @Max(10_000_000) codAmount: number;
  @IsOptional() @IsNumber() @Min(0.1) @Max(500) weightKg?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000) pieces?: number;
  @IsOptional() @IsString() itemsDescription?: string;
  @IsOptional() @IsString() remarks?: string;
  @IsOptional() @IsBoolean() fragile?: boolean;
  @IsOptional() @IsIn(['NORMAL', 'REVERSE', 'REPLACEMENT']) orderType?: 'NORMAL' | 'REVERSE' | 'REPLACEMENT';
  @IsOptional() @IsString() pickupAddressCode?: string;
  @IsOptional() @IsString() serviceCode?: string;
  /** By default a second booking for the same orderRef+courier is rejected to avoid double COD bookings. */
  @IsOptional() @IsBoolean() allowDuplicate?: boolean;
}

export class TrackItemDto {
  @IsString() courier: string;
  @IsString() trackingNumber: string;
  @IsOptional() @IsString() accountId?: string;
}

export class TrackBulkDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => TrackItemDto) items: TrackItemDto[];
}

export class ListShipmentsQuery {
  @IsOptional() @IsString() courier?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() orderRef?: string;
  @IsOptional() @IsString() trackingNumber?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
