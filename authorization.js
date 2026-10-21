// Only admins and owners may delete records.
export function canDelete(role) {
  return role === 'admin' || 'owner';
}
