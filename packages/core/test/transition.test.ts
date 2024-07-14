import {
  assign,
  createMachine,
  enqueueActions,
  setup,
  transition,
  executeAction,
  raise,
  createActor,
  fromTransition
} from '../src';
import { initialTransition } from '../src/transition';

describe('transition function', () => {
  it('should capture actions', () => {
    const actionWithParams = jest.fn();
    const actionWithDynamicParams = jest.fn();
    const stringAction = jest.fn();

    const machine = setup({
      types: {
        context: {} as { count: number },
        events: {} as { type: 'event'; msg: string }
      },
      actions: {
        actionWithParams,
        actionWithDynamicParams: (_, params: { msg: string }) => {
          actionWithDynamicParams(params);
        },
        stringAction
      }
    }).createMachine({
      entry: [
        { type: 'actionWithParams', params: { a: 1 } },
        'stringAction',
        assign({ count: 100 })
      ],
      context: { count: 0 },
      on: {
        event: {
          actions: {
            type: 'actionWithDynamicParams',
            params: ({ event }) => {
              return { msg: event.msg };
            }
          }
        }
      }
    });

    const [state0, actions0] = initialTransition(machine);

    expect(state0.context.count).toBe(100);
    expect(actions0).toEqual([
      expect.objectContaining({ type: 'actionWithParams', params: { a: 1 } }),
      expect.objectContaining({ type: 'stringAction' })
    ]);

    expect(actionWithParams).not.toHaveBeenCalled();
    expect(stringAction).not.toHaveBeenCalled();

    // Execute actions
    actions0.forEach((a) => executeAction(a, {} as any));

    expect(actionWithParams).toHaveBeenCalledWith(expect.anything(), { a: 1 });
    expect(stringAction).toHaveBeenCalled();

    const [state1, actions1] = transition(machine, state0, {
      type: 'event',
      msg: 'hello'
    });

    expect(state1.context.count).toBe(100);
    expect(actions1).toEqual([
      expect.objectContaining({
        type: 'actionWithDynamicParams',
        params: { msg: 'hello' }
      })
    ]);

    expect(actionWithDynamicParams).not.toHaveBeenCalled();

    // Execute actions
    actions1.forEach((a) => executeAction(a, {} as any));

    expect(actionWithDynamicParams).toHaveBeenCalledWith({
      msg: 'hello'
    });
  });

  it('should capture enqueued actions', () => {
    const machine = createMachine({
      entry: [
        enqueueActions((x) => {
          x.enqueue('stringAction');
          x.enqueue({ type: 'objectAction' });
        })
      ]
    });

    const [_state, actions] = initialTransition(machine);

    expect(actions).toEqual([
      expect.objectContaining({ type: 'stringAction' }),
      expect.objectContaining({ type: 'objectAction' })
    ]);
  });

  it('actor can be specified', () => {
    const machine = createMachine({
      entry: (x) => {
        x.self.send({ type: 'next' });
      },
      initial: 'a',
      states: {
        a: {
          on: { next: 'b' }
        },
        b: {}
      }
    });

    const [state, actions] = initialTransition(machine);

    const actor = createActor(machine, {
      snapshot: state
    }).start();

    expect(actor.getSnapshot().matches('a')).toBeTruthy();

    actions.forEach((action) => {
      executeAction(action, actor);
    });

    expect(actor.getSnapshot().matches('b')).toBeTruthy();
  });

  // Copied from getSnapshot.test.ts

  it('should calculate the next snapshot for transition logic', () => {
    const logic = fromTransition(
      (state, event) => {
        if (event.type === 'next') {
          return { count: state.count + 1 };
        } else {
          return state;
        }
      },
      { count: 0 }
    );

    const [init] = initialTransition(logic);
    const [s1] = transition(logic, init, { type: 'next' });
    expect(s1.context.count).toEqual(1);
    const [s2] = transition(logic, s1, { type: 'next' });
    expect(s2.context.count).toEqual(2);
  });

  it('should calculate the next snapshot for machine logic', () => {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: 'b'
          }
        },
        b: {
          on: {
            NEXT: 'c'
          }
        },
        c: {}
      }
    });

    const [init] = initialTransition(machine);
    const [s1] = transition(machine, init, { type: 'NEXT' });

    expect(s1.value).toEqual('b');

    const [s2] = transition(machine, s1, { type: 'NEXT' });

    expect(s2.value).toEqual('c');
  });
  it('should not execute entry actions', () => {
    const fn = jest.fn();

    const machine = createMachine({
      initial: 'a',
      entry: fn,
      states: {
        a: {},
        b: {}
      }
    });

    initialTransition(machine);

    expect(fn).not.toHaveBeenCalled();
  });

  it('should not execute transition actions', () => {
    const fn = jest.fn();

    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            event: {
              target: 'b',
              actions: fn
            }
          }
        },
        b: {}
      }
    });

    const [init] = initialTransition(machine);
    const [nextSnapshot] = transition(machine, init, { type: 'event' });

    expect(fn).not.toHaveBeenCalled();
    expect(nextSnapshot.value).toEqual('b');
  });
});
