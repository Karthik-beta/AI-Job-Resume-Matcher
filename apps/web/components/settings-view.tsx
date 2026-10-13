"use client";

import { useEffect, useRef, useState } from "react";
import { AppPage } from "@/components/app-page";
import { ClearCache } from "@/components/clear-cache";
import { JobSources } from "@/components/job-sources";
import { MatchingSection } from "@/components/matching-section";
import { ResumeSection } from "@/components/resume-section";
import { RunSection } from "@/components/run-section";
import { ScheduleSection } from "@/components/schedule-section";
import { settingsSections } from "@/components/settings-section";
import { useEditableSettings } from "@/lib/settings";

export function SettingsView() {
  return (
    <AppPage title="Settings" className="gap-16">
      <SettingsContent />
    </AppPage>
  );
}

const sourcesWaitMs = 3_000;

function SettingsContent() {
  const settings = useEditableSettings();
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  // Sections move as their data arrives, so the hash is followed once everything above it loaded.
  // Sources that fail to load show an error instead, so they are not waited for long.
  useEffect(() => {
    const timer = window.setTimeout(() => setSourcesLoaded(true), sourcesWaitMs);
    return () => window.clearTimeout(timer);
  }, []);
  useHashFocus(!settings.isPending && sourcesLoaded);

  return (
    <>
      <SectionNav />
      <ResumeSection />
      <JobSources onChange={() => setSourcesLoaded(true)} />
      <MatchingSection />
      <RunSection />
      <ScheduleSection />
      <ClearCache />
    </>
  );
}

function SectionNav() {
  return (
    <nav aria-label="Settings sections" className="-mx-2.5 -mt-10 -mb-6 overflow-x-auto">
      <ul className="flex gap-1 whitespace-nowrap">
        {settingsSections.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className="inline-flex h-8 items-center rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const sectionIds: readonly string[] = settingsSections.map((section) => section.id);

// Scrolls to the section named by the URL hash and focuses its heading, on load (including a
// client-side navigation from another page) and whenever the hash changes. Section ids are plain
// ASCII, so the raw hash is matched against them and is never decoded.
function useHashFocus(ready: boolean) {
  const interacted = useUserInteracted();
  useEffect(() => {
    if (!ready) return;
    function follow() {
      const id = window.location.hash.slice(1);
      if (!sectionIds.includes(id)) return;
      const section = document.getElementById(id);
      const heading = section?.querySelector<HTMLElement>("[data-section-heading]");
      if (!section || !heading) return;
      section.scrollIntoView({ block: "start" });
      heading.focus({ preventScroll: true });
    }
    // The first follow can wait for slow data; by then the user may have moved on, and is not
    // pulled back. A hash change later is their own navigation, so it is always followed.
    if (!interacted.current) follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [ready, interacted]);
}

const interactionEvents = ["pointerdown", "keydown", "wheel", "touchstart", "focusin"] as const;

// Becomes true once the user clicks, types, scrolls by wheel or touch, or moves focus. Scroll
// events are not used, since the browser scrolls to a hash on its own.
function useUserInteracted() {
  const interacted = useRef(false);
  useEffect(() => {
    const mark = () => {
      interacted.current = true;
      for (const type of interactionEvents) window.removeEventListener(type, mark, true);
    };
    for (const type of interactionEvents) {
      window.addEventListener(type, mark, { capture: true, passive: true });
    }
    return () => {
      for (const type of interactionEvents) window.removeEventListener(type, mark, true);
    };
  }, []);
  return interacted;
}
