import { IsString, MinLength } from 'class-validator';

export class SubmittedDto {
  @IsString()
  @MinLength(1)
  txHash: string;
}
