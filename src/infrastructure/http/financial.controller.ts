import { Body, Controller, Get, Post, Param, Query, Headers, Inject, Res, UseGuards } from '@nestjs/common';
import { CreateWallet } from '../../application/wallet/create-wallet.js';
import { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction.js';
import { FinancialQueries } from '../../application/queries/financial-queries.js';
import { token, wagerInput, walletInput } from './transport-validation.js';
import type { ApiResponse } from './api-errors.js';
import { ProviderIdentityGuard } from './provider-identity.guard.js';
@Controller()
@UseGuards(ProviderIdentityGuard)
export class FinancialController {
  constructor(@Inject(CreateWallet) private readonly create: CreateWallet,
    @Inject(ProcessWagerTransaction) private readonly process: ProcessWagerTransaction,
    @Inject(FinancialQueries) private readonly queries: FinancialQueries) {}
  @Post('wallets') open(@Body() input: unknown) { return this.create.execute(walletInput(input)); }
  @Get('wallets/:walletId') wallet(@Param('walletId') id: string) { return this.queries.wallet(token(id)); }
  @Get('wallets/:walletId/ledger') ledger(@Param('walletId') id: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    if ((cursor !== undefined && typeof cursor !== 'string') || (limit !== undefined && (typeof limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(limit)))) token('');
    return this.queries.ledger(token(id), cursor, limit === undefined ? 50 : Number(limit));
  }
  @Get('wagering/transactions/:transactionId') transaction(@Param('transactionId') id: string) { return this.queries.transaction(token(id)); }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId') external(@Param('providerId') provider: string, @Param('externalTransactionId') id: string) {
    return this.queries.transaction(token(id), token(provider));
  }
  @Post('wagering/transactions') async submit(@Body() input: unknown, @Headers('idempotency-key') key: unknown, @Res({ passthrough: true }) response: ApiResponse) {
    const result = await this.process.execute(wagerInput(input, key));
    response.status(result.status === 'PENDING_REFERENCE' ? 202 : result.status === 'REJECTED' ? 422 : result.status === 'FAILED' ? 500 : 200);
    return result;
  }
  @Post('wallets/:walletId/reconciliation') async reconcile(@Param('walletId') id: string, @Res({ passthrough: true }) response: ApiResponse) {
    response.status(200); return this.queries.reconcile(token(id));
  }
}
