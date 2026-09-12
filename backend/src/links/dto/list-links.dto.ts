import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const STATUSES = [
  'open',
  'underpaid',
  'paid',
  'expired',
  'cancelled',
] as const;

export class ListLinksQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];
}
