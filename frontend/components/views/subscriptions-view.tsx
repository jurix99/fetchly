"use client"

import { SubscriptionsPanel } from "@/components/subscriptions-panel"

/** Abonnements promoted to a first-level view (was a tab inside Explorer). */
export function SubscriptionsView() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <SubscriptionsPanel />
    </div>
  )
}
