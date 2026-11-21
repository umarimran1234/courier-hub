import { CanActivate, createParamDecorator, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Tenant } from '@prisma/client';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

/** Tenant authentication: `x-api-key: chk_...` */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const key = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (!key || typeof key !== 'string') throw new UnauthorizedException('Missing x-api-key');
    const tenant = await this.prisma.tenant.findUnique({ where: { apiKeyHash: CryptoService.hashApiKey(key) } });
    if (!tenant) throw new UnauthorizedException('Invalid API key');
    req.tenant = tenant;
    return true;
  }
}

/** Admin authentication: `x-admin-key` must equal ADMIN_KEY env. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private cfg: ConfigService) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const expected = this.cfg.get<string>('ADMIN_KEY');
    const got = req.headers['x-admin-key'];
    if (!expected || typeof got !== 'string' || !CryptoService.safeEqual(got, expected)) throw new UnauthorizedException('Invalid admin key');
    return true;
  }
}

export const CurrentTenant = createParamDecorator((_: unknown, ctx: ExecutionContext): Tenant => ctx.switchToHttp().getRequest().tenant);
