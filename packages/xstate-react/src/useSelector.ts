import { useMemo } from 'react';
import { useSubscription } from 'use-subscription';
import { ActorRef, Interpreter, Subscribable } from 'xstate';
import { isActorWithState } from './useActor';
import { getServiceSnapshot } from './useService';

function isService(actor: any): actor is Interpreter<any, any, any, any> {
  return 'state' in actor && 'machine' in actor;
}

const defaultCompare = (a, b) => a === b;
const defaultGetSnapshot = (a) =>
  isService(a)
    ? getServiceSnapshot(a)
    : isActorWithState(a)
    ? a.state
    : undefined;

export function useSelector<
  TActor extends ActorRef<any, any>,
  T,
  TEmitted = TActor extends Subscribable<infer Emitted> ? Emitted : never
>(
  actor: TActor,
  selector: (emitted: TEmitted) => T,
  compare: (a: T, b: T) => boolean = defaultCompare,
  getSnapshot: (a: TActor) => TEmitted = defaultGetSnapshot
) {
  const subscription = useMemo(() => {
    let current = selector(getSnapshot(actor));

    return {
      getCurrentValue: () => current,
      subscribe: (callback) => {
        const sub = actor.subscribe((emitted) => {
          const next = selector(emitted);
          if (!compare(current, next)) {
            current = next;
            callback();
          }
        });
        return () => {
          sub.unsubscribe();
        };
      }
    };
    // intentionally omit `getSnapshot` as it is only supposed to read the "initial" snapshot of an actor
  }, [actor, selector, compare]);

  const selected = useSubscription(subscription);

  return selected;
}
