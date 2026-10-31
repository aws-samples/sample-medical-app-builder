import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { loadRuntimeConfig } from '../config/env';
import { DispatcherPrimitiveExecutor } from '../primitives/data/dispatcherExecutor';
import { MockPrimitiveExecutor } from '../primitives/data/mock/mockExecutor';
import type { PatientHit } from '../primitives/data/types';
import { PatientPicker, hitLabel, rememberPatient, rememberedPatient } from '../panel/PatientPicker';
import { theme } from '../theme';

const dispatcherConfig = loadRuntimeConfig({ VITE_HOSPITAL_ID: 'hsp-test', VITE_AUTH_MODE: 'cognito', VITE_DATA_MODE: 'dispatcher', VITE_REGISTRY_MODE: 'remote', VITE_API_BASE_URL: 'https://api.example.test', VITE_COGNITO_REGION: 'eu-central-1', VITE_COGNITO_USER_POOL_ID: 'eu-central-1_x', VITE_COGNITO_CLIENT_ID: 'c' });

// The hospital's patients: no MRN, a study-name identifier that says nothing about the person.
const HITS: PatientHit[] = [
  { id: '9f39b44f11f5492c0c7534225fcecdad', name: 'Gilderoy Lockhart', birthDate: '1931-12-02', gender: 'male', identifiers: [{ system: 'urn:study-name', value: 'AWS_COHORT' }] },
  { id: '5fce5df772615e0fd911fa3e5989c9b2', name: 'Arthur Weasley', birthDate: '1949-05-12', gender: 'male', identifiers: [{ system: 'https://hospital/mrn', value: 'MRN-42' }] },
];

describe('patient picker against a hospital record', () => {
  beforeEach(() => sessionStorage.clear());

  it('lists the first page of the record before anyone types, searches by name debounced, and hands over the chosen id', async () => {
    const search = vi.fn(async (name: string) => (name ? HITS.filter((h) => h.name.toLowerCase().includes(name.toLowerCase())) : HITS));
    const onChange = vi.fn();
    render(
      <MantineProvider theme={theme}>
        <PatientPicker value="" onChange={onChange} config={dispatcherConfig} search={search} />
      </MantineProvider>
    );
    // One call on mount: the first page (by family name on the server), so the list is not empty.
    await waitFor(() => expect(search).toHaveBeenCalledWith(''));
    await screen.findByText(/The first 2 patients of the record/);
    const box = screen.getByTestId('patient-search');
    fireEvent.focus(box);
    await screen.findByText('Gilderoy Lockhart · 1931-12-02, male');

    fireEvent.change(box, { target: { value: 'w' } });
    await new Promise((r) => setTimeout(r, 350));
    expect(search).toHaveBeenCalledTimes(1); // one letter is not a search
    fireEvent.change(box, { target: { value: 'we' } });
    fireEvent.change(box, { target: { value: 'weas' } });
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(search).toHaveBeenLastCalledWith('weas'); // the keystrokes within the delay collapsed into one call
    fireEvent.focus(box);
    const option = await screen.findByText('Arthur Weasley · 1949-05-12, male · MRN-42');
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('5fce5df772615e0fd911fa3e5989c9b2');
    // Remembered for the tab, so the launcher can restore it after opening an app.
    expect(rememberedPatient()).toEqual({ id: '5fce5df772615e0fd911fa3e5989c9b2', label: 'Arthur Weasley · 1949-05-12, male · MRN-42' });
    // The free id still wins, for a patient known by id.
    fireEvent.change(screen.getByPlaceholderText('Patient id'), { target: { value: 'abc-123' } });
    expect(onChange).toHaveBeenLastCalledWith('abc-123');
  });

  it('restores the remembered patient on mount and shows its label without a search', async () => {
    rememberPatient({ id: '5fce5df772615e0fd911fa3e5989c9b2', label: 'Arthur Weasley · 1949-05-12, male · MRN-42' });
    const search = vi.fn(async () => [] as PatientHit[]);
    const seen: string[] = [];
    // The launcher: holds the selection in state, as a parent does, so the control can display what was restored.
    function Launcher() {
      const [value, setValue] = useState('');
      return (
        <PatientPicker
          value={value}
          onChange={(id) => {
            seen.push(id);
            setValue(id);
          }}
          config={dispatcherConfig}
          search={search}
        />
      );
    }
    render(
      <MantineProvider theme={theme}>
        <Launcher />
      </MantineProvider>
    );
    await waitFor(() => expect(seen).toEqual(['5fce5df772615e0fd911fa3e5989c9b2']));
    await waitFor(() => expect(screen.getByTestId('patient-search')).toHaveValue('Arthur Weasley · 1949-05-12, male · MRN-42'));
    // The sentence under the box says what the choice does — and does not do.
    expect(screen.getByText(/Single-patient apps open for Arthur Weasley\. The list of apps is not filtered by this; population apps ignore it\. Clear \(×\) to choose no one\./)).toBeInTheDocument();

    // Clear (×): back to no patient, and the tab forgets it too — deleting the text used to leave the choice standing.
    fireEvent.click(screen.getByLabelText('Clear the patient')); // Mantine's clear button is aria-hidden (the field itself is the accessible control), so by its label
    expect(seen).toEqual(['5fce5df772615e0fd911fa3e5989c9b2', '']);
    expect(rememberedPatient()).toBeNull();
    await waitFor(() => expect(screen.getByTestId('patient-search')).toHaveValue(''));
    expect(screen.getByText(/^Whose record a single-patient app shows when you open it\./)).toBeInTheDocument();
  });

  it('the seed list (mock mode) can be cleared the same way, and says what choosing does', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <MantineProvider theme={theme}>
        <PatientPicker value="pat-kms-0001" onChange={onChange} config={{ ...dispatcherConfig, data: { ...dispatcherConfig.data, mode: 'mock' } } as typeof dispatcherConfig} />
      </MantineProvider>
    );
    expect(screen.getByText(/Single-patient apps open for Anneliese Krüger\. The list of apps is not filtered by this/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Clear the patient')); // Mantine's clear button is aria-hidden (the field itself is the accessible control), so by its label
    expect(onChange).toHaveBeenCalledWith('');
    rerender(
      <MantineProvider theme={theme}>
        <PatientPicker value="" onChange={onChange} config={{ ...dispatcherConfig, data: { ...dispatcherConfig.data, mode: 'mock' } } as typeof dispatcherConfig} />
      </MantineProvider>
    );
    expect(screen.getByTestId('patient-seed')).toHaveValue('');
    expect(screen.getByPlaceholderText('No patient chosen')).toBeInTheDocument();
    expect(screen.queryByLabelText('Clear the patient')).toBeNull(); // nothing to clear
  });

  it('labels a hit without a usable identifier by name, birth date and sex only', () => {
    expect(hitLabel(HITS[0]!)).toBe('Gilderoy Lockhart · 1931-12-02, male');
    expect(hitLabel({ id: 'x', name: 'Nobody', identifiers: [] })).toBe('Nobody');
  });

  it('the dispatcher executor calls GET /patients with the token and surfaces the dispatcher message', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ patients: HITS, audit_id: 'a-1' }), { status: 200 });
    }) as typeof fetch;
    const executor = new DispatcherPrimitiveExecutor('https://api.example.test', fetchImpl, () => 'id-token');
    expect(await executor.searchPatients('lock hart')).toEqual(HITS);
    expect(seen.url).toBe('https://api.example.test/patients?name=lock%20hart');
    expect((seen.init?.headers as Record<string, string>).authorization).toBe('Bearer id-token');
    const refusing = new DispatcherPrimitiveExecutor('https://api.example.test', (async () => new Response(JSON.stringify({ message: "Type at least two characters of the patient's name." }), { status: 400 })) as typeof fetch);
    await expect(refusing.searchPatients('a')).rejects.toThrow('at least two characters');
  });

  it('the mock executor searches the seed the same way', async () => {
    const executor = new MockPrimitiveExecutor();
    const hits = await executor.searchPatients('krüg');
    expect(hits.map((h) => h.name)).toEqual(['Anneliese Krüger']);
    expect(hits[0]?.identifiers.some((i) => i.value === 'KMS-0048213')).toBe(true);
    await expect(executor.searchPatients('k')).rejects.toThrow('at least two characters');
    expect((await executor.searchPatients('')).map((h) => h.name)).toEqual(['Jonas Bergmann', 'Anneliese Krüger', 'Fatma Yıldız']); // the first page, by family name
  });
});
