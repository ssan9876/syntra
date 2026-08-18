import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
// `AppShell`, which every portal page renders, calls `useSession`, so a page
// mounted without the provider throws before it renders anything. The plan's
// fixture omitted it and all six cases died on the same line.
import { SessionProvider } from "../../session/SessionProvider.js";
import { CatalogPage } from "./CatalogPage.js";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  }) as never;

function mockCatalog(products: Record<string, unknown>[]) {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(json({ products })),
  );
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <SessionProvider>
        <CatalogPage />
      </SessionProvider>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe("CatalogPage", () => {
  it("says plainly when a product is granted immediately", async () => {
    // The catalog shows such a product as "granted immediately" so the
    // requester knows BEFORE they ask.
    mockCatalog([
      {
        id: "p1",
        name: "Reading room",
        slug: "reading-room",
        description: null,
        category: null,
        kind: "application",
        durationMode: "permanent",
        maxDurationDays: null,
        needsApproval: false,
      },
    ]);
    renderPage();
    expect(await screen.findByText(/granted immediately/i)).toBeInTheDocument();
  });

  it("says how long a time-bounded product runs for", async () => {
    mockCatalog([
      {
        id: "p2",
        name: "Finance folder",
        slug: "finance-folder",
        description: null,
        category: "Finance",
        kind: "targetEntitlement",
        durationMode: "requesterChoice",
        maxDurationDays: 90,
        needsApproval: true,
      },
    ]);
    renderPage();
    expect(await screen.findByText(/up to 90 days/i)).toBeInTheDocument();
  });

  it("shows an empty catalog as a fact rather than an error", async () => {
    // An empty catalog is what a correctly-configured tenant looks like on day
    // one, and it is what a person outside every audience sees. Neither is a
    // failure, and saying "something went wrong" would send them to support.
    mockCatalog([]);
    renderPage();
    expect(
      await screen.findByText(/nothing to ask for yet/i),
    ).toBeInTheDocument();
  });
});
