//! Fixed worker counts and a bounded handoff keep network and extraction separate.
use std::sync::{atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering}, mpsc, Mutex};
use std::time::Instant;

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchMetrics {
    pub network_jobs: usize,
    pub extract_jobs: usize,
    pub queue_capacity: usize,
    pub peak_preparing: usize,
    pub peak_extracting: usize,
    /// Summed worker time, including lock wait, cache validation and download.
    pub prepare_micros: u64,
    /// Summed worker time, including archive validation, extraction and publication.
    pub extract_micros: u64,
    /// Producer time blocked by the bounded handoff, summed across workers.
    pub backpressure_micros: u64,
}

fn micros(start: Instant) -> u64 { start.elapsed().as_micros().min(u64::MAX as u128) as u64 }

struct PendingQueue {
    fresh: std::collections::VecDeque<usize>,
    retries: std::collections::BinaryHeap<std::cmp::Reverse<(Instant, usize, u32)>>,
}
impl PendingQueue {
    fn next(&mut self) -> Option<Result<(usize, u32), std::time::Duration>> {
        if let Some(index) = self.fresh.pop_front() { return Some(Ok((index, 0))); }
        let &std::cmp::Reverse((due, _, _)) = self.retries.peek()?;
        let now = Instant::now();
        if due > now { return Some(Err(due.duration_since(now))); }
        let std::cmp::Reverse((_, index, attempts)) = self.retries.pop().unwrap();
        Some(Ok((index, attempts)))
    }
    fn defer(&mut self, index: usize, attempts: u32) {
        let delay = std::time::Duration::from_millis(2_u64 << attempts.min(4));
        self.retries.push(std::cmp::Reverse((Instant::now() + delay, index, attempts.saturating_add(1))));
    }
}

pub enum Preparation<S> {
    Complete(Option<S>),
    /// A contended content key returns to the queue without occupying this lane.
    Deferred,
}

pub fn run_pipeline<I: Sync, S: Send>(
    inputs: &[I], network_jobs: usize, extract_jobs: usize,
    prepare: impl Fn(&I) -> Result<Option<S>, String> + Sync,
    extract: impl Fn(S) -> Result<(), String> + Sync,
) -> Result<FetchMetrics, String> {
    run_retry_pipeline(inputs, network_jobs, extract_jobs,
        |input| prepare(input).map(Preparation::Complete), extract)
}

pub fn run_retry_pipeline<I: Sync, S: Send>(
    inputs: &[I],
    network_jobs: usize,
    extract_jobs: usize,
    prepare: impl Fn(&I) -> Result<Preparation<S>, String> + Sync,
    extract: impl Fn(S) -> Result<(), String> + Sync,
) -> Result<FetchMetrics, String> {
    if !(1..=256).contains(&network_jobs) || !(1..=256).contains(&extract_jobs) {
        return Err("Fetch worker counts must be between 1 and 256".into());
    }
    let mut result = FetchMetrics { network_jobs, extract_jobs, queue_capacity: extract_jobs, ..FetchMetrics::default() };
    if inputs.is_empty() { return Ok(result); }
    let pending = Mutex::new(PendingQueue { fresh: (0..inputs.len()).collect(), retries: Default::default() });
    let cancelled = AtomicBool::new(false);
    let error = Mutex::new(None);
    let preparing = AtomicUsize::new(0);
    let extracting = AtomicUsize::new(0);
    let peak_preparing = AtomicUsize::new(0);
    let peak_extracting = AtomicUsize::new(0);
    let prepare_time = AtomicU64::new(0);
    let extract_time = AtomicU64::new(0);
    let backpressure = AtomicU64::new(0);
    let (sender, receiver) = mpsc::sync_channel(extract_jobs);
    let receiver = Mutex::new(receiver);
    let record_error = |value: String| {
        cancelled.store(true, Ordering::Release);
        let mut error = error.lock().unwrap();
        if error.is_none() { *error = Some(value); }
    };
    std::thread::scope(|scope| {
        for _ in 0..extract_jobs.min(inputs.len()) {
            scope.spawn(|| loop {
                // Serialize only receipt, never extraction. Producers retain at
                // most one pending artifact each while the queue is full.
                let stage = match receiver.lock().unwrap().recv() { Ok(stage) => stage, Err(_) => break };
                if cancelled.load(Ordering::Acquire) { drop(stage); continue; }
                let active = extracting.fetch_add(1, Ordering::Relaxed) + 1;
                peak_extracting.fetch_max(active, Ordering::Relaxed);
                let start = Instant::now();
                let outcome = extract(stage);
                extract_time.fetch_add(micros(start), Ordering::Relaxed);
                extracting.fetch_sub(1, Ordering::Relaxed);
                if let Err(value) = outcome { record_error(value); }
            });
        }
        for _ in 0..network_jobs.min(inputs.len()) {
            let sender = sender.clone();
            let prepare = &prepare;
            let pending = &pending; let cancelled = &cancelled;
            let preparing = &preparing; let peak_preparing = &peak_preparing;
            let prepare_time = &prepare_time; let backpressure = &backpressure;
            let record_error = &record_error;
            scope.spawn(move || {
                while !cancelled.load(Ordering::Acquire) {
                    let next = pending.lock().unwrap().next();
                    let (index, attempts) = match next {
                        None => break,
                        Some(Ok(job)) => job,
                        Some(Err(delay)) => {
                            std::thread::sleep(delay.min(std::time::Duration::from_millis(10)));
                            continue;
                        }
                    };
                    let input = &inputs[index];
                    let active = preparing.fetch_add(1, Ordering::Relaxed) + 1;
                    peak_preparing.fetch_max(active, Ordering::Relaxed);
                    let start = Instant::now();
                    let outcome = prepare(input);
                    prepare_time.fetch_add(micros(start), Ordering::Relaxed);
                    preparing.fetch_sub(1, Ordering::Relaxed);
                    match outcome {
                        Ok(Preparation::Complete(Some(stage))) => {
                            if cancelled.load(Ordering::Acquire) { drop(stage); break; }
                            let start = Instant::now();
                            if sender.send(stage).is_err() { break; }
                            backpressure.fetch_add(micros(start), Ordering::Relaxed);
                        }
                        Ok(Preparation::Complete(None)) => {}
                        Ok(Preparation::Deferred) => {
                            pending.lock().unwrap().defer(index, attempts);
                        }
                        Err(value) => { record_error(value); break; }
                    }
                }
            });
        }
        drop(sender);
    });
    if let Some(error) = error.into_inner().unwrap() { return Err(error); }
    result.peak_preparing = peak_preparing.load(Ordering::Relaxed);
    result.peak_extracting = peak_extracting.load(Ordering::Relaxed);
    result.prepare_micros = prepare_time.load(Ordering::Relaxed);
    result.extract_micros = extract_time.load(Ordering::Relaxed);
    result.backpressure_micros = backpressure.load(Ordering::Relaxed);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;
    #[test]
    fn delayed_retries_do_not_reenter_preparation_or_delay_fresh_inputs() {
        let mut queue = PendingQueue { fresh: [1].into(), retries: Default::default() };
        queue.retries.push(std::cmp::Reverse((Instant::now() + std::time::Duration::from_secs(60), 0, 1)));
        assert_eq!(queue.next().unwrap().unwrap(), (1, 0));
        assert!(queue.next().unwrap().is_err());
        assert_eq!(queue.retries.len(), 1);
    }

    #[test]
    fn contended_key_yields_to_ready_work_with_one_lane() {
        let ready_processed = AtomicBool::new(false);
        let finished = AtomicUsize::new(0);
        run_retry_pipeline(&[0, 1], 1, 1, |index| {
            if *index == 0 && !ready_processed.load(Ordering::Relaxed) {
                return Ok(Preparation::Deferred);
            }
            if *index == 1 { ready_processed.store(true, Ordering::Relaxed); }
            Ok(Preparation::Complete(Some(*index)))
        }, |_| { finished.fetch_add(1, Ordering::Relaxed); Ok(()) }).unwrap();
        assert_eq!(finished.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn stages_overlap_with_independent_hard_limits() {
        let ready = Barrier::new(3);
        let finished = AtomicUsize::new(0);
        let metrics = run_pipeline(&(0..24).collect::<Vec<_>>(), 3, 1,
            |n| { if *n < 3 { ready.wait(); } Ok(Some(*n)) },
            |_| { finished.fetch_add(1, Ordering::Relaxed); Ok(()) }).unwrap();
        assert_eq!(metrics.peak_preparing, 3);
        assert_eq!(metrics.peak_extracting, 1);
        assert_eq!(metrics.queue_capacity, 1);
        assert_eq!(finished.load(Ordering::Relaxed), 24);
    }
    #[test]
    fn queued_resources_are_dropped_after_failure() {
        struct Stage<'a>(&'a AtomicUsize);
        impl Drop for Stage<'_> { fn drop(&mut self) { self.0.fetch_sub(1, Ordering::Relaxed); } }
        let alive = AtomicUsize::new(0);
        let result = run_pipeline(&(0..100).collect::<Vec<_>>(), 4, 2,
            |_| { alive.fetch_add(1, Ordering::Relaxed); Ok(Some(Stage(&alive))) },
            |_| Err("extract failure".into()));
        assert_eq!(result.unwrap_err(), "extract failure");
        assert_eq!(alive.load(Ordering::Relaxed), 0);
    }
    #[test]
    fn validation_and_cache_hits_need_no_extract() {
        assert!(run_pipeline(&[0], 0, 1, |_| Ok(Some(())), |_| Ok(())).is_err());
        let metrics = run_pipeline(&[0, 1], 1, 1, |_| Ok(None::<()>), |_| panic!("cache hit extracted")).unwrap();
        assert_eq!(metrics.peak_extracting, 0);
    }
}
