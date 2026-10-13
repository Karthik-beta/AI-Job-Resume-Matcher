import { Controller, HttpCode, Post } from "@nestjs/common";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { OnboardingService } from "./onboarding.service";

// Each answers with the user's onboarding state, as GET /api/overview reports it. All three are
// idempotent: completing or dismissing again keeps the first time.
@Controller("onboarding")
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post("complete")
  @HttpCode(200)
  complete(@Session() session: UserSession) {
    return this.onboarding.complete(session.user.id);
  }

  @Post("dismiss")
  @HttpCode(200)
  dismiss(@Session() session: UserSession) {
    return this.onboarding.dismiss(session.user.id);
  }

  @Post("restore")
  @HttpCode(200)
  restore(@Session() session: UserSession) {
    return this.onboarding.restore(session.user.id);
  }
}
