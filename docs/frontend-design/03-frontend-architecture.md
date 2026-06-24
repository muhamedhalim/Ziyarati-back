# 03 — Frontend Architecture

Next.js (App Router) · TypeScript · React Query · Zustand · Tailwind · shadcn/ui. The architecture
mirrors the backend's module boundaries 1:1 so each domain is independently ownable.

## 1. Folder structure

```
src/
├── app/                                  # App Router (routes only — thin)
│   ├── (auth)/login, /register, /forgot-password, /reset-password
│   ├── (workspace)/app/...               # clinic shell + every clinic route (see 01 sitemap)
│   ├── (platform)/platform/...           # super_admin console
│   ├── (portal)/portal/...               # customer portal
│   └── api/                              # BFF route handlers (token refresh proxy, file upload signing)
│
├── features/                             # one folder per backend module
│   ├── auth/                  { api, hooks, components, stores, schemas, types }
│   ├── tenant/                # tenant profile, settings, branches, verification
│   ├── appointments/
│   ├── reviews/
│   ├── crm/
│   ├── scheduling/
│   ├── staff/
│   ├── conversations/
│   ├── whatsapp/
│   ├── ai/
│   ├── campaigns/
│   ├── notifications/
│   ├── payments/
│   ├── billing/               # subscription-billing
│   ├── analytics/
│   └── platform/              # api-keys, api-logs, webhook-logs, files, system-settings
│
├── shared/
│   ├── api/                   # axios client, interceptors, error mapping, query-key factory
│   ├── components/            # DataTable, StatusBadge, Can, EntityDrawer, Money, DateTime, …
│   ├── ui/                    # shadcn primitives
│   ├── hooks/                 # usePagination, useFilters, useDebounce, useCan
│   ├── auth/                  # session store, guards, permission utils
│   ├── i18n/                  # next-intl config, ar/en messages, RTL
│   └── lib/                   # money, datetime (tz), idempotency, csv
│
└── config/                    # env, route map, nav map (permission-gated), enums (mirrors backend)
```

Each `features/<module>` folder is self-contained:

```
features/appointments/
├── api/appointments.api.ts        # raw endpoint fns (typed)
├── hooks/                         # useAppointments, useAppointment, useCreateAppointment, …
├── components/                    # AppointmentTable, AppointmentDrawer, BookingModal, RescheduleModal, Timeline, …
├── schemas/                       # zod (mirror DTOs)
├── types/                         # request/response types
└── index.ts
```

## 2. API layer

Single axios instance + a thin typed function per endpoint. **Never call axios from a component.**

```ts
// shared/api/client.ts
export const api = axios.create({ baseURL: `${ENV.API_URL}/api/v1` });

api.interceptors.request.use((cfg) => {
  const t = sessionStore.getState().accessToken;
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

// 401 → single-flight refresh → retry; else logout. Refresh is one-time-use (rotation).
api.interceptors.response.use(r => r, withRefreshRetry(api));

// normalize { statusCode, errorCode, message, requestId, timestamp }
api.interceptors.response.use(r => r, mapApiError);
```

```ts
// features/appointments/api/appointments.api.ts
export const appointmentsApi = {
  list:   (q: QueryAppointments) => api.get<Paginated<Appointment>>('/appointments', { params: q }),
  get:    (id: string)           => api.get<Appointment>(`/appointments/${id}`),
  create: (b: CreateAppointment) => api.post<Appointment>('/appointments', b),
  update: (id, b: UpdateAppointment) => api.patch(`/appointments/${id}`, b),
  setServices: (id, b) => api.put(`/appointments/${id}/services`, b),
  changeStatus:(id, b) => api.post(`/appointments/${id}/status`, b),
  cancel:      (id, b) => api.post(`/appointments/${id}/cancel`, b),
  reschedule:  (id, b) => api.post(`/appointments/${id}/reschedule`, b),
  addNote:     (id, b) => api.post(`/appointments/${id}/notes`, b),
  notes:       (id)    => api.get(`/appointments/${id}/notes`),
  timeline:    (id)    => api.get(`/appointments/${id}/timeline`),
  remove:      (id)    => api.delete(`/appointments/${id}`),
  createReview:(id, b) => api.post(`/appointments/${id}/review`, b),
  getReview:   (id)    => api.get(`/appointments/${id}/review`),
};
```

## 3. Hooks (React Query)

- **Query keys** via a central factory: `qk.appointments.list(filters)`, `qk.appointments.detail(id)`,
  `qk.appointments.timeline(id)`. Invalidate by prefix after mutations.
- **List hooks** take the filter/pagination object directly (it *is* the query key payload).
- **Mutation hooks** invalidate the affected list + detail + any audit/timeline view. Appointment
  status/cancel/reschedule all invalidate `detail` + `timeline` + `list`.
- `keepPreviousData: true` on paginated lists for smooth page changes.
- `staleTime`: reference data (plans, permissions catalogue, tags) 5–10 min; operational lists
  10–30 s; live inbox/handover counters poll 15–30 s (no websockets in backend — see gaps).

```ts
export const useAppointments = (q: QueryAppointments) =>
  useQuery({ queryKey: qk.appointments.list(q), queryFn: () => appointmentsApi.list(q).then(d=>d.data), keepPreviousData:true });

export const useCancelAppointment = (id: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: CancelAppointment) => appointmentsApi.cancel(id, b).then(d=>d.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.appointments.detail(id) });
                       qc.invalidateQueries({ queryKey: qk.appointments.timeline(id) });
                       qc.invalidateQueries({ queryKey: qk.appointments.lists() }); },
  });
};
```

## 4. State management (Zustand)

Client-only, ephemeral/UI state — server data lives in React Query.

| Store | Holds |
|---|---|
| `sessionStore` | accessToken, refreshToken, principal (`/auth/me`: id, email, tenantId, roles, permissions), `hasPermission()`, `hasRole()` |
| `tenantStore` | current tenant summary (`/tenants/me`), settings, **activeStatus** (drives the gate), selected branch |
| `uiStore` | nav collapsed, density, theme, RTL/locale |
| `filtersStore` (per module, optional) | last-used filters persisted per list |
| `inboxStore` | selected conversation, composer draft, optimistic outbox |

Persist `session` (storage of choice) + `ui`; everything else is memory.

## 5. Permission & route guards

```ts
// shared/auth/permissions.ts
export const useCan = () => {
  const { permissions, roles } = sessionStore();
  const isSuper = roles.some(r => r.slug === 'super_admin');   // '*' → all
  return {
    can:    (p: PermissionSlug) => isSuper || permissions.includes(p),
    canAny: (...p) => isSuper || p.some(x => permissions.includes(x)),
    canAll: (...p) => isSuper || p.every(x => permissions.includes(x)),
    isRole: (r: RoleSlug) => roles.some(x => x.slug === r),
  };
};
```

```tsx
<Can permission="payments.read">…</Can>
<Can anyOf={['campaigns.manage']}>…</Can>
```

**Route guards** (layout-level):
- `(workspace)/layout` → requires a tenant principal; if `tenantId == null` (super_admin) redirect
  to `/platform`. Then check **ActiveTenant**: if not approved/active → render onboarding/suspended
  shell instead of children.
- `(platform)/layout` → requires `super_admin`.
- `(portal)/layout` → requires `customer`.
- **Per-route permission**: a `routePermissions` map in `config/` is checked in each segment's
  layout; a missing permission renders 403 (not a redirect loop).

The nav map is data-driven: `nav.ts` lists items with `{ href, label, icon, permission|role }`;
the sidebar filters by `useCan`, so adding a screen = one entry.

## 6. Shared components (the reused 20)

`DataTable` · `StatusBadge` · `Can` · `EntityDrawer` (tabbed) · `ConfirmDialog` ·
`ReasonDialog` (cancel/reject/reject-handover) · `Money` · `DateTime` (tz-aware) ·
`DateRangeFilter` · `FilterBar` · `Pagination` · `SearchInput` (debounced) · `UuidCell` (copy) ·
`Avatar` · `RoleChip` · `TagChip` · `ChannelChip` · `KpiCard` · `ChartCard` · `TimelineFeed` ·
`FileDropzone` (→ upload → pass URL to DTO) · `Stepper` (onboarding/campaign).

## 7. File uploads (important pattern)

The backend takes **URLs, not multipart** for most attachments (verification docs, staff avatar,
customer files, training files). Flow: client uploads to storage (S3/R2 — via a BFF
`/api/upload-sign` route handler or `platform/files` if used as the store), gets a URL, then sends
that URL in the create DTO. Build one `useUpload()` hook returning `{ url }` and reuse it.

## 8. Error & resilience conventions

- Global `QueryCache.onError` → toast for background failures; inline error cards for primary views.
- Mutations surface 409/422 `message` verbatim (business rules) and field errors from 400.
- Retry: GET retried twice with backoff; mutations **never** auto-retried (idempotency keys cover
  payment/send safety).
- A global `<ActiveTenantBoundary>` intercepts the 403 "tenant not active" shape and routes to the
  status screen instead of showing a generic error on every panel.

## 9. Testing & types

- Generate types from the live **OpenAPI/Swagger** the backend already serves (every controller is
  `@ApiTags`-documented) → `openapi-typescript` into `features/*/types`. Keeps DTO/enums in lockstep.
- MSW handlers per module for component tests; Playwright for the critical flows in `05`.
