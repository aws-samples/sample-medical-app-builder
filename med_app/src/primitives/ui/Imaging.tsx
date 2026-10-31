import { useEffect, useRef, useState } from 'react';
import type { ImagingStudy, ImagingStudySeries } from '@medplum/fhirtypes';
import { formatDate, formatDateTime } from '@medplum/core';
import { ActionIcon, Badge, Group, Paper, SegmentedControl, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { IconArrowsMaximize, IconArrowsMinimize, IconMaximize, IconScan } from '@tabler/icons-react';
import { useRenderContext } from '../../renderer/RenderContext';
import { scales, tokens } from '../../theme';

export function studyInstanceUid(study: ImagingStudy): string | undefined {
  const raw = study.identifier?.find((i) => i.system === 'urn:dicom:uid')?.value;
  return raw?.replace(/^urn:oid:/, '');
}

export interface ImagingStudyListProps {
  readonly studies?: ImagingStudy[];
  readonly title?: string;
  /** UI-state key written on row selection; a DicomViewer reads it back via $ui.<key>. */
  readonly selection_key?: string;
}

export function ImagingStudyList({ studies = [], title = 'Imaging studies', selection_key = 'selected_study' }: ImagingStudyListProps) {
  const { ui, setUiState } = useRenderContext();
  const selected = ui[selection_key];

  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Group justify="space-between" align="baseline">
          <Title order={4}>{title}</Title>
          <Text size="sm" c="dimmed">
            {studies.length} {studies.length === 1 ? 'study' : 'studies'}
          </Text>
        </Group>
        {studies.length === 0 ? (
          <Text size="sm" c="dimmed">
            No imaging studies for this patient.
          </Text>
        ) : (
          // A fixed layout keeps the table inside its column however narrow the column is (a 4/12 or 5/12 list
          // beside the viewer): the three short columns get what they need, the description takes the rest and
          // wraps. The date shows the day; the time is a tooltip — a study list is scanned by day.
          <Table highlightOnHover withRowBorders layout="fixed" style={{ width: '100%' }}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={96}>Date</Table.Th>
                <Table.Th w={64}>Mod.</Table.Th>
                <Table.Th>Description</Table.Th>
                <Table.Th w={104} ta="right" style={{ whiteSpace: 'nowrap' }}>
                  Series · images
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {studies.map((s) => {
                const uid = studyInstanceUid(s);
                const isSelected = uid !== undefined && uid === selected;
                return (
                  <Table.Tr
                    key={s.id}
                    onClick={() => uid && setUiState(selection_key, uid)}
                    style={{ cursor: uid ? 'pointer' : 'default', background: isSelected ? scales.clinical[0] : undefined }}
                    aria-selected={isSelected}
                    data-testid="imaging-study-row"
                  >
                    <Table.Td style={{ whiteSpace: 'nowrap' }} title={s.started ? formatDateTime(s.started) : undefined}>
                      {s.started ? formatDate(s.started) : '—'}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        {s.modality?.map((m) => (
                          <Badge key={m.code} color="ink" tt="none">
                            {m.code}
                          </Badge>
                        ))}
                      </Group>
                    </Table.Td>
                    <Table.Td style={{ overflowWrap: 'anywhere' }}>{s.description ?? '—'}</Table.Td>
                    <Table.Td ta="right" style={{ whiteSpace: 'nowrap' }}>
                      {s.numberOfSeries ?? s.series?.length ?? 0} · {s.numberOfInstances ?? 0}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
    </Paper>
  );
}

/** How the viewer lays the study out: a 2-D stack, the three reconstructed planes, or those plus a volume rendering. */
export type ViewerLayout = 'stack' | 'mpr' | 'volume';
export const VIEWER_LAYOUTS: readonly ViewerLayout[] = ['stack', 'mpr', 'volume'];

export interface DicomViewerProps {
  readonly study_uid?: string;
  readonly studies?: ImagingStudy[];
  readonly height_px?: number;
  readonly title?: string;
  /** The layout the study opens in; the header lets the user switch. */
  readonly layout?: ViewerLayout;
}

// OHIF's hanging protocols for each layout (`hangingProtocolId` in the viewer URL); a stack is OHIF's default.
// OHIF's built-in hanging protocols. `fourUp` is the 2×2 of axial, volume rendering, coronal and sagittal for any
// reconstructable series; `mprAnd3DVolumeViewport` is the same grid but CT-only (an MR study opens four empty
// viewports), so it is not used.
const HANGING_PROTOCOL: Record<Exclude<ViewerLayout, 'stack'>, string> = { mpr: 'mpr', volume: 'fourUp' };

/** The series a reconstruction should be built from: the one with the most images — the acquisition volume. */
export function volumeSeriesUid(study: ImagingStudy | undefined): string | undefined {
  return volumeSeries(study)?.uid;
}

/** The series a viewer should reconstruct: the one with the most images (the acquisition stack, not a topogram or a reformat). */
function volumeSeries(study: ImagingStudy | undefined): ImagingStudySeries | undefined {
  const candidates = (study?.series ?? []).filter((s) => s.uid);
  if (!candidates.length) return undefined;
  return [...candidates].sort((a, b) => (b.numberOfInstances ?? 0) - (a.numberOfInstances ?? 0))[0];
}

/** Fewer slices than this and there is no volume to reconstruct (a radiograph, a two-image topogram, a sweep of ultrasound frames). */
export const MIN_VOLUME_SLICES = 12;

/**
 * Whether MPR and 3-D make sense for the study: unknown series (a PACS answering without them) → yes, let the
 * viewer try; a known largest series below the threshold → no, the controls are disabled and the study opens 2-D.
 */
export function reconstructable(study: ImagingStudy | undefined): boolean {
  const volume = volumeSeries(study);
  if (!volume || volume.numberOfInstances === undefined) return true;
  return volume.numberOfInstances >= MIN_VOLUME_SLICES;
}

/**
 * The URL the viewer is opened on: the study in the query, the signed-in user's token in the fragment. The
 * fragment never leaves the browser (not sent to any server, not in access logs); the viewer's app-config.js
 * reads it once and attaches it as the Authorization header of every DICOMweb request to the PACS door.
 * A reconstruction (MPR, 3-D) names its hanging protocol and, when the study says which series is the volume,
 * that series — otherwise OHIF would reconstruct whatever comes first, a two-image topogram included.
 */
export function viewerUrl(viewerBase: string, studyUid: string, idToken?: string, options: { layout?: ViewerLayout; seriesUid?: string; dataSource?: string } = {}): string {
  // OHIF registers a route per data source: `/viewer/<name>` opens the study from that source, `/viewer` from the default.
  const source = options.dataSource ? `/${encodeURIComponent(options.dataSource)}` : '';
  let url = `${viewerBase}/viewer${source}?StudyInstanceUIDs=${encodeURIComponent(studyUid)}`;
  if (options.layout && options.layout !== 'stack') {
    if (options.seriesUid) url += `&SeriesInstanceUIDs=${encodeURIComponent(options.seriesUid)}`;
    url += `&hangingProtocolId=${HANGING_PROTOCOL[options.layout]}`;
  }
  return idToken ? `${url}#token=${encodeURIComponent(idToken)}` : url;
}

/**
 * OHIF embed. The viewer URL is deployment configuration, never manifest data,
 * so a manifest cannot point the iframe anywhere else. Without a configured viewer the
 * component shows the selected study's metadata instead of failing silently.
 */
export function DicomViewer({ study_uid, studies = [], height_px = 560, title = 'Study viewer', layout = 'stack' }: DicomViewerProps) {
  const { config, identity } = useRenderContext();
  const study = studies.find((s) => studyInstanceUid(s) === study_uid);
  const viewerBase = config.imaging.ohifViewerUrl;
  const [view, setView] = useState<ViewerLayout>(VIEWER_LAYOUTS.includes(layout) ? layout : 'stack');
  const canReconstruct = reconstructable(study);
  const effectiveView: ViewerLayout = canReconstruct ? view : 'stack';
  // A reading viewer wants the whole screen, not a column: "expand" lays the same iframe over the page (no
  // reload — the element stays mounted), Esc or the button brings the page back; "full screen" is the browser's.
  const [expanded, setExpanded] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const showsViewer = Boolean(study_uid && viewerBase);

  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [expanded]);

  const expandedStyle = { position: 'fixed' as const, inset: 0, zIndex: 400, borderRadius: 0, display: 'flex', flexDirection: 'column' as const, background: 'var(--mantine-color-body)' };

  return (
    <Paper withBorder p="md" style={expanded ? expandedStyle : { minHeight: height_px }} data-testid="dicom-viewer" data-expanded={expanded || undefined}>
      <Stack gap="sm" h="100%" style={expanded ? { flex: 1, minHeight: 0 } : undefined}>
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap="sm" align="baseline" wrap="nowrap" style={{ minWidth: 0 }}>
            <Title order={4}>{title}</Title>
            {study_uid && (
              <Text size="xs" c="dimmed" className="ds-mono" style={{ wordBreak: 'break-all' }}>
                {study_uid}
              </Text>
            )}
          </Group>
          {showsViewer && (
            <Group gap={4} wrap="nowrap">
              <Tooltip label={canReconstruct ? 'How the study opens: the 2-D stack, the three reconstructed planes, or those with a 3-D volume rendering' : 'Not enough slices in this study to reconstruct a volume'} openDelay={400}>
                <SegmentedControl
                  size="xs"
                  value={effectiveView}
                  onChange={(v) => setView(v as ViewerLayout)}
                  data={[
                    { value: 'stack', label: '2D' },
                    { value: 'mpr', label: 'MPR', disabled: !canReconstruct },
                    { value: 'volume', label: '3D', disabled: !canReconstruct },
                  ]}
                  aria-label="Viewer layout"
                  data-testid="viewer-layout"
                  data-reconstructable={canReconstruct || undefined}
                />
              </Tooltip>
              <Tooltip label={expanded ? 'Back to the page (Esc)' : 'Expand over the page'}>
                <ActionIcon variant="subtle" color="gray" aria-label={expanded ? 'Back to the page' : 'Expand the viewer'} onClick={() => setExpanded((e) => !e)} data-testid="viewer-expand">
                  {expanded ? <IconArrowsMinimize size={18} stroke={1.5} /> : <IconArrowsMaximize size={18} stroke={1.5} />}
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Full screen">
                <ActionIcon variant="subtle" color="gray" aria-label="Full screen" onClick={() => void frame.current?.requestFullscreen?.()} data-testid="viewer-fullscreen">
                  <IconMaximize size={18} stroke={1.5} />
                </ActionIcon>
              </Tooltip>
            </Group>
          )}
        </Group>
        {!study_uid ? (
          <Stack align="center" justify="center" gap="xs" style={{ flex: 1, minHeight: height_px - 80, color: tokens.muted }}>
            <IconScan size={40} stroke={1.25} />
            <Text size="sm" c="dimmed">
              Select a study from the list to open it here.
            </Text>
          </Stack>
        ) : viewerBase ? (
          <iframe
            ref={frame}
            title={`OHIF viewer — ${study_uid}`}
            src={viewerUrl(viewerBase, study_uid, identity.idToken, { layout: effectiveView, seriesUid: volumeSeriesUid(study), dataSource: config.imaging.viewerDataSource })}
            style={expanded ? { border: 0, width: '100%', flex: 1, minHeight: 0, background: '#000' } : { border: 0, width: '100%', height: height_px - 80, background: '#000' }}
            allow="fullscreen"
          />
        ) : (
          <Stack gap="xs" style={{ flex: 1 }}>
            <Text size="sm" c="dimmed">
              No OHIF viewer configured (VITE_OHIF_VIEWER_URL). Showing study metadata from the imaging primitive.
            </Text>
            {study && (
              <Table withRowBorders>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Td fw={500}>Description</Table.Td>
                    <Table.Td>{study.description ?? '—'}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td fw={500}>Started</Table.Td>
                    <Table.Td>{formatDateTime(study.started)}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td fw={500}>Modality</Table.Td>
                    <Table.Td>{study.modality?.map((m) => m.code).join(', ')}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td fw={500}>Series</Table.Td>
                    <Table.Td>
                      <Stack gap={2}>
                        {study.series?.map((se) => (
                          <Text key={se.uid} size="sm">
                            {se.number}. {se.description ?? se.uid} — {se.numberOfInstances ?? 0} images
                            {se.bodySite?.display ? ` · ${se.bodySite.display}` : ''}
                          </Text>
                        ))}
                      </Stack>
                    </Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
            )}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
