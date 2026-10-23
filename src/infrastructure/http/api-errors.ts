import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { InvalidWagerInputError } from '../../application/wagering/prepare-wager.js';
import { WagerProcessingError } from '../../application/wagering/wager-processing-error.js';
import { WalletAlreadyExistsError } from '../../application/errors/wallet-already-exists-error.js';
import { RetryableFinancialTransactionError } from '../../application/errors/retryable-financial-transaction-error.js';
import { MoneyError } from '../../domain/money/money-error.js';
import { InvalidCursorError, ResourceNotFoundError } from '../../application/queries/financial-queries.js';
export function publicError(error: unknown): { status: number; code: string } {
  if (error instanceof InvalidWagerInputError || error instanceof MoneyError || error instanceof InvalidCursorError) return { status: 400, code: error.code };
  if (error instanceof ResourceNotFoundError) return { status: 404, code: error.code };
  if (error instanceof WalletAlreadyExistsError) return { status: 409, code: error.code };
  if (error instanceof WagerProcessingError) return { status: error.code === 'WALLET_NOT_FOUND' ? 404 : error.code.endsWith('CONFLICT') ? 409 : error.code === 'ORIGINAL_RESULT_UNAVAILABLE' ? 500 : 422, code: error.code };
  if (error instanceof RetryableFinancialTransactionError) return { status: 503, code: 'TEMPORARILY_UNAVAILABLE' };
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && (/^08/.test(code) || ['57P01','57P02','57P03','53300','55P03','57014','ECONNREFUSED','ECONNRESET','ETIMEDOUT'].includes(code))) return { status: 503, code: 'TEMPORARILY_UNAVAILABLE' };
  if (error instanceof HttpException) return { status: error.getStatus(), code: error.getStatus() === 503 ? 'NOT_READY' : 'INVALID_REQUEST' };
  return { status: 500, code: 'INTERNAL_ERROR' };
}
export interface ApiResponse { status(code: number): ApiResponse; json(body: unknown): void; setHeader(key: string, value: string): void; }
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ApiResponse>();
    const request = host.switchToHttp().getRequest<{ correlationId?: string }>();
    const outcome = publicError(error);
    response.status(outcome.status).json({ error: { code: outcome.code }, correlationId: request.correlationId });
  }
}
