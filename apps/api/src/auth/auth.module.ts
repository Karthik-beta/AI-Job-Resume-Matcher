import { AuthModule as BetterAuthModule } from "@thallesp/nestjs-better-auth";
import { PrismaService } from "../prisma/prisma.service";
import { createAuth } from "./auth";

export const AuthModule = BetterAuthModule.forRootAsync({
  inject: [PrismaService],
  useFactory: (prisma: PrismaService) => ({ auth: createAuth(prisma) }),
});
