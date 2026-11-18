import { SetMetadata } from '@nestjs/common';
import { BextraRole } from './auth.types.js';

export const ROLES_KEY = 'bextra_roles';
export const Roles = (...roles: BextraRole[]) => SetMetadata(ROLES_KEY, roles);
