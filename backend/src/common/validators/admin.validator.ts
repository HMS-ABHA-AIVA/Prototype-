import {z} from 'zod';

export const loginAdminSchema = z.object({
  email: z.email("Invalid email").max(254, "Invalid email"),
  password: z.string().min(1, "Password is required").max(128, "Invalid password"),
});
