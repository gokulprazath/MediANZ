// Component tests with the mock store behind the DataApi context.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Field } from "@/components/form-field";
import { StarInput } from "@/components/star-rating";
import { Input } from "@/components/ui/input";
import { FeesForm } from "@/features/appointments/fees-form";
import { ConsultPanel } from "@/features/consult/consult-panel";
import type { DataApi } from "@/lib/data/api";
import { ApiProvider } from "@/lib/data/context";
import { APPT, buildSeed } from "@/lib/mock/seed";
import { createMockApi } from "@/lib/mock/store";
import { authId } from "@/lib/mock/users";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function wrap(api: DataApi, ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ApiProvider value={{ api, subscribeSlots: () => () => undefined }}>{ui}</ApiProvider>
    </QueryClientProvider>,
  );
}

describe("Field", () => {
  it("wires the label, hint and error to the control", () => {
    render(
      <Field label="Postcode" hint="4 digits" error="Postcode is 4 digits">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText("Postcode");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("4 digits Postcode is 4 digits");
  });
});

describe("StarInput", () => {
  it("is a labelled radio group", async () => {
    const onChange = vi.fn();
    render(<StarInput label="Overall" value={null} onChange={onChange} />);
    expect(screen.getByRole("group", { name: "Overall" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "4 stars" }));
    expect(onChange).toHaveBeenCalledWith(4);
  });
});

describe("FeesForm", () => {
  it("defaults the gap to fee minus rebate and saves", async () => {
    const state = buildSeed();
    const staff = createMockApi(state, authId(21));
    const a = (await staff.getAppointment(APPT(101)))!;
    wrap(staff, <FeesForm appointment={a} />);
    await userEvent.type(screen.getByLabelText("Fee charged ($)"), "80");
    await userEvent.type(screen.getByLabelText("Medicare rebate ($)"), "41.40");
    expect(screen.getByLabelText("Gap ($)")).toHaveValue(38.6);
    await userEvent.click(screen.getByRole("button", { name: "Save fees" }));
    await waitFor(() => expect(state.appointments.find((x) => x.id === APPT(101))?.gap_amount).toBe(38.6));
  });
});

describe("ConsultPanel", () => {
  it("shows the consent wording and both parties' consent state", async () => {
    const state = buildSeed();
    const staff = createMockApi(state, authId(21));
    const priya = createMockApi(state, authId(3));
    const sophie = createMockApi(state, authId(13));
    await staff.updateAppointment(APPT(103), { status: "checked_in" });
    const a = (await priya.getAppointment(APPT(103)))!;
    wrap(priya, <ConsultPanel appointment={a} party="patient" userId={authId(3)} />);
    expect(screen.getByText("Audio is not stored")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "I agree to recording" }));
    expect(await screen.findByText(/Waiting for your clinician to agree/)).toBeInTheDocument();
    expect(state.recording_consents.some((c) => c.appointment_id === APPT(103) && c.party === "patient")).toBe(true);
    expect(screen.getByRole("button", { name: "Withdraw consent" })).toBeInTheDocument();

    // Once the clinician agrees and starts recording on their device.
    await sophie.giveConsent(APPT(103), "v1");
    await sophie.transcribeStart(APPT(103));
    wrap(priya, <ConsultPanel appointment={a} party="patient" userId={authId(3)} />);
    expect(await screen.findByText("Recording on the clinician's device")).toBeInTheDocument();
  });
});
