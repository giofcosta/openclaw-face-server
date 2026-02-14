import { IsString, IsNotEmpty } from 'class-validator';

export class GetTokenDto {
  @IsString()
  @IsNotEmpty()
  apiKey: string;
}
