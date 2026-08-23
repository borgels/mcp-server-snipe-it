/**
 * Generic entity catalog: every standard Laravel resource in Snipe-IT with
 * index/show/create/update, plus the subresources each one exposes.
 * Assets (hardware) have richer dedicated tools and are not listed here.
 */
export interface EntityDefinition {
  path: string;
  label: string;
  /** Allowed `include` values on get: subresource path segments. */
  subresources: string[];
  /**
   * Query parameters the index endpoint actually honours, transcribed from the
   * `$request->filled('…')` guards in each Snipe-IT API controller's index().
   *
   * Allowlisted on purpose. Snipe-IT silently ignores a parameter it does not
   * recognise, so a typo comes back as HTTP 200 with the filter simply not
   * applied — which reads as a real answer. Failing loudly on an unknown key is
   * the whole reason these are enumerated rather than passed through blind.
   *
   * `search` is excluded because it has its own tool argument, and `filter`
   * (Snipe-IT's JSON advanced-filter blob) is excluded deliberately: it is a
   * different shape from these scalar filters and invites malformed input.
   */
  filters: readonly string[];
}

export const ENTITIES = {
  licenses: {
    path: '/licenses',
    label: 'Licenses',
    subresources: ['seats', 'history'],
    // expires/maintained are the compliance questions: expires=true lists
    // licences whose expiration_date has passed.
    filters: [
      'category_id', 'company_id', 'created_by', 'depreciation_id', 'expires', 'license_email',
      'license_name', 'maintained', 'manufacturer_id', 'name', 'order_number', 'product_key',
      'purchase_order', 'supplier_id',
    ],
  },
  accessories: {
    path: '/accessories',
    label: 'Accessories',
    subresources: ['checkedout', 'history'],
    filters: ['category_id', 'company_id', 'location_id', 'manufacturer_id', 'notes', 'order_number', 'supplier_id'],
  },
  consumables: {
    path: '/consumables',
    label: 'Consumables',
    subresources: ['users', 'history'],
    filters: [
      'category_id', 'company_id', 'location_id', 'manufacturer_id', 'model_number', 'name', 'notes',
      'order_number', 'supplier_id',
    ],
  },
  components: {
    path: '/components',
    label: 'Components',
    subresources: ['assets', 'history'],
    filters: [
      'category_id', 'company_id', 'location_id', 'manufacturer_id', 'model_number', 'name', 'notes',
      'order_number', 'supplier_id',
    ],
  },
  users: {
    path: '/users',
    label: 'Users',
    subresources: ['assets', 'accessories', 'licenses', 'history'],
    filters: [
      'accessories_count', 'activated', 'all', 'assets_count', 'assigned_maintenances_count',
      'autoassign_licenses', 'company_id', 'consumables_count', 'country', 'created_by', 'deleted',
      'department_id', 'display_name', 'email', 'employee_num', 'end_date', 'first_name', 'group_id',
      'last_name', 'ldap_import', 'licenses_count', 'locale', 'location_id', 'manager_id',
      'manages_locations_count', 'manages_users_count', 'mobile', 'phone', 'remote', 'start_date',
      'state', 'two_factor_enrolled', 'two_factor_optin', 'username', 'vip', 'website', 'zip',
    ],
  },
  locations: {
    path: '/locations',
    label: 'Locations',
    subresources: ['users', 'assets', 'assigned/assets', 'assigned/accessories', 'history'],
    filters: ['address', 'city', 'company_id', 'country', 'manager_id', 'name', 'parent_id', 'tag_color', 'zip'],
  },
  statuslabels: {
    path: '/statuslabels',
    label: 'Status labels',
    subresources: ['assetlist'],
    filters: ['name', 'status_type'],
  },
  categories: {
    path: '/categories',
    label: 'Categories',
    subresources: [],
    filters: [
      'category_type', 'checkin_email', 'created_at', 'created_by', 'name', 'require_acceptance',
      'updated_at', 'use_default_eula',
    ],
  },
  manufacturers: {
    path: '/manufacturers',
    label: 'Manufacturers',
    subresources: [],
    filters: ['name', 'support_email', 'support_phone', 'support_url', 'tag_color', 'url', 'warranty_lookup_url'],
  },
  models: {
    path: '/models',
    label: 'Asset models',
    subresources: ['history'],
    filters: ['category_id', 'depreciation_id', 'model_number', 'name', 'notes'],
  },
  companies: {
    path: '/companies',
    label: 'Companies',
    subresources: [],
    filters: ['created_by', 'email', 'name', 'parent_id', 'tag_color'],
  },
  departments: {
    path: '/departments',
    label: 'Departments',
    subresources: [],
    filters: ['company_id', 'location_id', 'manager_id', 'name', 'tag_color'],
  },
  suppliers: {
    path: '/suppliers',
    label: 'Suppliers',
    subresources: [],
    filters: ['address', 'city', 'country', 'email', 'fax', 'name', 'notes', 'url', 'zip'],
  },
  // The custom-field endpoints take no filters, but they are how you discover
  // the `_snipeit_*` payload keys — see snipeit_get_entity's description.
  fields: { path: '/fields', label: 'Custom fields', subresources: [], filters: [] },
  fieldsets: { path: '/fieldsets', label: 'Fieldsets', subresources: ['fields'], filters: [] },
  kits: {
    path: '/kits',
    label: 'Predefined kits',
    subresources: ['licenses', 'models', 'accessories', 'consumables'],
    filters: [],
  },
  maintenances: {
    path: '/maintenances',
    label: 'Asset maintenances',
    subresources: ['history', 'notes'],
    filters: [
      'asset_id', 'checked_out_to_id', 'completed', 'created_by', 'maintenance_type',
      'maintenance_type_id', 'responsible_party_id', 'supplier_id', 'upcoming_status', 'url',
    ],
  },
  depreciations: { path: '/depreciations', label: 'Depreciations', subresources: [], filters: [] },
  groups: { path: '/groups', label: 'Permission groups', subresources: [], filters: ['name'] },
} as const satisfies Record<string, EntityDefinition>;

export type EntityName = keyof typeof ENTITIES;

export const ENTITY_NAMES = Object.keys(ENTITIES) as [EntityName, ...EntityName[]];

/** Entities where create/update via the generic write tools is allowed. */
export const WRITABLE_ENTITIES = new Set<EntityName>([
  'licenses',
  'accessories',
  'consumables',
  'components',
  'users',
  'locations',
  'statuslabels',
  'categories',
  'manufacturers',
  'models',
  'companies',
  'departments',
  'suppliers',
  'maintenances',
]);

export function entityDefinition(name: string): EntityDefinition {
  const definition = (ENTITIES as Record<string, EntityDefinition>)[name];
  if (!definition) {
    throw new Error(`Unknown entity: ${name}. Valid: ${ENTITY_NAMES.join(', ')}`);
  }
  return definition;
}
