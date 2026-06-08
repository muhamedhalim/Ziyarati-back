  import { Global, Module } from '@nestjs/common';
  import { APP_INTERCEPTOR } from '@nestjs/core';
  import { TypeOrmModule } from '@nestjs/typeorm';

  import { Tenant } from '../../entities/SaaS-Core/Tenant';
  import { TenantContextService } from './tenant-context.service';
  import { TenantLookupService } from './tenant-lookup.service';
  import { TenantContextInterceptor } from './tenant-context.interceptor';
  import { ActiveTenantGuard } from './active-tenant.guard';

  /**
   * Core Tenant Runtime Layer.
   *
   * Global so any module can inject TenantContextService / apply ActiveTenantGuard
   * without re-importing. Provides:
   *  - TenantContextService (ALS-backed, single source of truth);
   *  - TenantContextInterceptor (global APP_INTERCEPTOR) that fills the context;
   *  - ActiveTenantGuard (opt-in, exported for @UseGuards in business modules).
   *
   * The ALS store is opened by a request middleware wired in main.ts.
   */
  @Global()
  @Module({
    imports: [TypeOrmModule.forFeature([Tenant])],
    providers: [
      TenantContextService,
      TenantLookupService,
      ActiveTenantGuard,
      { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    ],
    exports: [TenantContextService, TenantLookupService, ActiveTenantGuard],
  })
  export class TenantContextModule {}
