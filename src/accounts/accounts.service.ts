import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Courier, CourierAccount } from '@prisma/client';
import { CryptoService } from '../common/crypto.service';
import { CourierRegistry } from '../couriers/courier.registry';
import { AccountContext } from '../couriers/courier.types';
import { CourierError } from '../couriers/courier.errors';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateAccountInput {
  courier: Courier;
  label?: string;
  sandbox?: boolean;
  credentials: Record<string, any>;
  verify?: boolean;
}

@Injectable()
export class AccountsService {
  constructor(private prisma: PrismaService, private crypto: CryptoService, private registry: CourierRegistry) {}

  toContext(acc: CourierAccount): AccountContext {
    return { id: acc.id, courier: acc.courier, sandbox: acc.sandbox, credentials: this.crypto.decryptJson(acc.credentialsEnc) };
  }

  /** Never returns credentials. */
  public(acc: CourierAccount) {
    return {
      id: acc.id,
      courier: acc.courier,
      label: acc.label,
      sandbox: acc.sandbox,
      active: acc.active,
      webhookToken: acc.webhookToken,
      createdAt: acc.createdAt,
    };
  }

  async create(tenantId: string, input: CreateAccountInput) {
    const adapter = this.registry.get(input.courier);
    const missing = adapter.requiredCredentials.filter((k) => input.credentials?.[k] === undefined || input.credentials[k] === '');
    if (missing.length) throw new BadRequestException(`Missing credential fields for ${input.courier}: ${missing.join(', ')}`);

    const label = input.label || 'default';
    const exists = await this.prisma.courierAccount.findUnique({ where: { tenantId_courier_label: { tenantId, courier: input.courier, label } } });
    if (exists) throw new ConflictException(`An account "${label}" for ${input.courier} already exists`);

    if (input.verify !== false) {
      try {
        await adapter.verifyCredentials({ id: 'verify', courier: input.courier, sandbox: !!input.sandbox, credentials: input.credentials });
      } catch (e) {
        if (e instanceof CourierError) throw new BadRequestException(`Courier rejected these credentials: ${e.message}`);
        throw e;
      }
    }

    const acc = await this.prisma.courierAccount.create({
      data: {
        tenantId,
        courier: input.courier,
        label,
        sandbox: !!input.sandbox,
        credentialsEnc: this.crypto.encryptJson(input.credentials),
      },
    });
    return this.public(acc);
  }

  async list(tenantId: string) {
    const rows = await this.prisma.courierAccount.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.public(r));
  }

  async get(tenantId: string, id: string): Promise<CourierAccount> {
    const acc = await this.prisma.courierAccount.findFirst({ where: { id, tenantId } });
    if (!acc) throw new NotFoundException('Courier account not found');
    return acc;
  }

  /** Explicit account, or the tenant's first active account for that courier. */
  async resolve(tenantId: string, courier: Courier, accountId?: string): Promise<CourierAccount> {
    if (accountId) {
      const acc = await this.get(tenantId, accountId);
      if (acc.courier !== courier) throw new BadRequestException(`Account ${accountId} belongs to ${acc.courier}, not ${courier}`);
      return acc;
    }
    const acc = await this.prisma.courierAccount.findFirst({ where: { tenantId, courier, active: true }, orderBy: { createdAt: 'asc' } });
    if (!acc) throw new NotFoundException(`No active ${courier} account connected. Add one via POST /v1/accounts`);
    return acc;
  }

  async verify(tenantId: string, id: string) {
    const acc = await this.get(tenantId, id);
    await this.registry.get(acc.courier).verifyCredentials(this.toContext(acc));
    return { ok: true };
  }

  async setActive(tenantId: string, id: string, active: boolean) {
    await this.get(tenantId, id);
    const acc = await this.prisma.courierAccount.update({ where: { id }, data: { active } });
    return this.public(acc);
  }

  async remove(tenantId: string, id: string) {
    await this.get(tenantId, id);
    const inUse = await this.prisma.shipment.count({ where: { accountId: id, isTerminal: false } });
    if (inUse) throw new ConflictException(`${inUse} shipment(s) on this account are still in progress. Deactivate it instead (PATCH active=false).`);
    await this.prisma.courierAccount.delete({ where: { id } });
    return { ok: true };
  }
}
