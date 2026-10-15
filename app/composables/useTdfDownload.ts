/**
 * **Download TDF** (ADR-0012 decision 7): the archived results file of a tournament, saved under its
 * `Content-Disposition` name. Upcoming and This week's cards share it; a refusal (`no_tdf`, `tdf_key_mismatch`) is a
 * toast and nothing is saved.
 */
export function useTdfDownload() {
  const toast = useToast();
  return async function downloadTdf(tournamentId: string, displayId: string | null): Promise<void> {
    try {
      const res = await $fetch.raw<Blob>(`/api/tournaments/${tournamentId}/tdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(res._data!);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName(res.headers.get('content-disposition'), displayId);
      a.click();
      // Revoked once the browser has started the download, not before.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not download the TDF.') });
    }
  };
}
