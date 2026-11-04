import manager from '../utils/webrtcManager2';

beforeEach(() => { manager.dataChannels.clear(); manager.receivingFiles.clear(); });

test('empty files arrive and report finite completion', async () => {
  const progress = jest.fn();
  const received = jest.fn();
  manager.onFileReceived = received;
  manager.onProgressUpdate = progress;
  const messages = [];
  manager.dataChannels.set('peer', { readyState: 'open', bufferedAmount: 0, send: data => messages.push(data) });
  await manager.sendFile('peer', new File([], 'empty.txt'), progress);
  for (const data of messages) await manager.handleDataChannelMessage('peer', data);
  expect(received).toHaveBeenCalledWith('empty.txt', expect.any(Blob), 'peer', expect.objectContaining({size: 0}));
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ progress: 100 }));
  expect(manager.receivingFiles.size).toBe(0);
});

test('multi-chunk transfers preserve every byte', async () => {
  const bytes = new Uint8Array(40000).map((_, i) => i % 251);
  const messages = [];
  manager.dataChannels.set('peer', { readyState: 'open', bufferedAmount: 0, send: data => messages.push(data) });
  const received = jest.fn(); manager.onFileReceived = received;
  await manager.sendFile('peer', new File([bytes], 'payload.bin'));
  for (const data of messages) await manager.handleDataChannelMessage('peer', data);
  const blob = received.mock.calls[0][1];
  const result = await new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsArrayBuffer(blob); });
  expect(new Uint8Array(result)).toEqual(bytes);
});

test('file read errors reject instead of leaving the send pending', async () => {
  manager.dataChannels.set('peer', { readyState: 'open', bufferedAmount: 0, send: jest.fn() });
  const spy = jest.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(function () { this.onerror(); });
  try { await expect(manager.sendFile('peer', new File(['test'], 'broken.txt'))).rejects.toThrow('Could not read file'); }
  finally { spy.mockRestore(); }
});
