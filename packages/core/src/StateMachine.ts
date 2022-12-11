import {
  ActorContext,
  AnyEventObject,
  AnyStateMachine,
  InvokeActionObject,
  MachineConfig2,
  MachineImplementations2,
  Spawner,
  TransitionDefinition
} from '.';
import { actionTypes, createInitEvent } from './actions';
import { STATE_DELIMITER } from './constants';
import { MachineTypes, PartialMachineTypes } from './createTypes';
import { execAction } from './exec';
import { createSpawner } from './spawn';
import { isStateConfig, State } from './State';
import { StateNode } from './StateNode';
import {
  getConfiguration,
  getStateNodes,
  getStateValue,
  isStateId,
  macrostep,
  microstep,
  resolveStateValue,
  transitionNode
} from './stateUtils';
import type {
  AreAllImplementationsAssumedToBeProvided,
  MarkAllImplementationsAsProvided,
  ResolveTypegenMeta,
  TypegenConstraint,
  TypegenDisabled
} from './typegenTypes';
import type {
  ActorMap,
  BaseActionObject,
  Event,
  EventObject,
  InternalMachineImplementations,
  MachineConfig,
  MachineContext,
  MachineImplementationsSimplified,
  MachineSchema,
  NoInfer,
  SCXML,
  StateConfig,
  StateNodeDefinition,
  StateValue
} from './types';
import { isFunction, isSCXMLErrorEvent, toSCXMLEvent } from './utils';

export const NULL_EVENT = '';
export const STATE_IDENTIFIER = '#';
export const WILDCARD = '*';

function createDefaultOptions() {
  return {
    actions: {},
    actors: {},
    delays: {},
    guards: {},
    context: {}
  };
}

function resolveContext<TContext extends MachineContext>(
  context: TContext,
  partialContext?: Partial<TContext>
): TContext {
  if (isFunction(partialContext)) {
    return { ...context, ...partialContext };
  }

  return {
    ...context,
    ...partialContext
  };
}

export class StateMachine<
  TContext extends MachineContext,
  TEvent extends EventObject = EventObject,
  TAction extends BaseActionObject = BaseActionObject,
  TActorMap extends ActorMap = ActorMap,
  TResolvedTypesMeta = ResolveTypegenMeta<
    TypegenDisabled,
    NoInfer<TEvent>,
    TAction,
    TActorMap
  >,
  TTypes extends MachineTypes<any> = MachineTypes<any>,
  TProvided = unknown
> {
  private _contextFactory: (stuff: {
    spawn: Spawner;
    input: TTypes['input'];
  }) => TContext;
  public get context(): TContext {
    return this.getContextAndActions()[0];
  }
  private getContextAndActions(): [TContext, InvokeActionObject[]] {
    const actions: InvokeActionObject[] = [];
    // TODO: merge with this.options.context
    const context = this._contextFactory({
      spawn: createSpawner(this, null as any, null as any, actions), // TODO: fix types
      input: this.options.input
    });

    return [context, actions];
  }
  /**
   * The machine's own version.
   */
  public version?: string;

  /**
   * The string delimiter for serializing the path to a string. The default is "."
   */
  public delimiter: string;

  public options: MachineImplementationsSimplified<TContext, TEvent>;

  public schema: MachineSchema<TContext, TEvent>;

  public __xstatenode: true = true;

  public idMap: Map<string, StateNode<TContext, TEvent>> = new Map();

  public root: StateNode<TContext, TEvent>;

  public id: string;

  public states: StateNode<TContext, TEvent>['states'];

  public events: Array<TEvent['type']>;

  public input: any = {};

  constructor(
    /**
     * The raw config used to create the machine.
     */
    public config: MachineConfig<TContext, TEvent, any, any, any>,
    options?: MachineImplementationsSimplified<TContext, TEvent>
  ) {
    this.id = config.id || '(machine)';
    this.options = Object.assign(createDefaultOptions(), options);
    this._contextFactory = isFunction(config.context)
      ? config.context
      : (stuff) => {
          const partialContext =
            typeof options?.context === 'function'
              ? options.context(stuff)
              : options?.context;

          return resolveContext(
            config.context as TContext,
            partialContext
          ) as TContext;
        }; // TODO: fix types
    // this.context = resolveContext(config.context, options?.context);
    this.delimiter = this.config.delimiter || STATE_DELIMITER;
    this.version = this.config.version;
    this.schema = this.config.schema ?? (({} as any) as this['schema']);
    this.transition = this.transition.bind(this);

    this.root = new StateNode(config, {
      _key: this.id,
      _machine: this
    });

    this.root._initialize();

    this.states = this.root.states; // TODO: remove!
    this.events = this.root.events;
  }

  /**
   * Clones this state machine with the provided implementations
   * and merges the `context` (if provided).
   *
   * @param implementations Options (`actions`, `guards`, `actors`, `delays`, `context`)
   *  to recursively merge with the existing options.
   *
   * @returns A new `StateMachine` instance with the provided implementations.
   */
  public provide<
    T extends Partial<MachineImplementationsSimplified<TContext, TEvent, any>>
  >(
    implementations: T
  ): StateMachine<
    TContext,
    TEvent,
    TAction,
    TActorMap,
    AreAllImplementationsAssumedToBeProvided<TResolvedTypesMeta> extends false
      ? MarkAllImplementationsAsProvided<TResolvedTypesMeta>
      : TResolvedTypesMeta,
    TTypes,
    TProvided & T
  > {
    const { actions, guards, actors, delays, input } = this.options;

    return new StateMachine(this.config, {
      actions: { ...actions, ...implementations.actions },
      guards: { ...guards, ...implementations.guards },
      actors: { ...actors, ...implementations.actors },
      delays: { ...delays, ...implementations.delays },
      context: implementations.context!,
      input
    });
  }

  /**
   * Clones this state machine with custom `context`.
   *
   * The `context` provided can be partial `context`, which will be combined with the original `context`.
   *
   * @param context Custom context (will override predefined context, not recursive)
   */
  public withContext(context: Partial<TContext>): this;
  public withContext(context: Partial<TContext>): AnyStateMachine {
    return this.provide({
      context
    } as any);
  }

  /**
   * Resolves the given `state` to a new `State` instance relative to this machine.
   *
   * This ensures that `.nextEvents` represent the correct values.
   *
   * @param state The state to resolve
   */
  public resolveState(
    state: State<TContext, TEvent, TResolvedTypesMeta>
  ): typeof state {
    const configurationSet = getConfiguration(
      getStateNodes(this.root, state.value)
    );
    const configuration = Array.from(configurationSet);
    return this.createState({
      ...state,
      value: resolveStateValue(this.root, state.value),
      configuration
    } as StateConfig<TContext, TEvent>);
  }

  public resolveStateValue(
    stateValue: StateValue
  ): State<TContext, TEvent, TResolvedTypesMeta> {
    const resolvedStateValue = resolveStateValue(this.root, stateValue);
    const resolvedContext = this.context;

    return this.resolveState(
      State.from(resolvedStateValue, resolvedContext, this)
    );
  }

  /**
   * Determines the next state given the current `state` and received `event`.
   * Calculates a full macrostep from all microsteps.
   *
   * @param state The current State instance or state value
   * @param event The received event
   */
  public transition(
    state: StateValue | State<TContext, TEvent, TResolvedTypesMeta> = this
      .initialState,
    event: Event<TEvent> | SCXML.Event<TEvent>,
    actorCtx?: ActorContext<TEvent, State<TContext, TEvent, any>>
  ): State<TContext, TEvent, TResolvedTypesMeta, TTypes> {
    const currentState =
      state instanceof State ? state : this.resolveStateValue(state);
    // TODO: handle error events in a better way
    const scxmlEvent = toSCXMLEvent(event);
    if (
      isSCXMLErrorEvent(scxmlEvent) &&
      !currentState.nextEvents.some(
        (nextEvent) => nextEvent === scxmlEvent.name
      )
    ) {
      throw scxmlEvent.data.data;
    }

    const { state: nextState } = macrostep(currentState, scxmlEvent, actorCtx);

    return nextState;
  }

  /**
   * Determines the next state given the current `state` and `event`.
   * Calculates a microstep.
   *
   * @param state The current state
   * @param event The received event
   */
  public microstep(
    state: State<TContext, TEvent, TResolvedTypesMeta> = this.initialState,
    event: Event<TEvent> | SCXML.Event<TEvent>,
    actorCtx?: ActorContext<any, any>
  ): State<TContext, TEvent, TResolvedTypesMeta>[] {
    const scxmlEvent = toSCXMLEvent(event);

    const { microstates } = macrostep(state, scxmlEvent, actorCtx);

    return microstates;
  }

  public getTransitionData(
    state: State<TContext, TEvent, TResolvedTypesMeta>,
    _event: SCXML.Event<TEvent>
  ): Array<TransitionDefinition<TContext, TEvent>> {
    // return this.transition(state, _event).transitions;
    return transitionNode(this.root, state.value, state, _event) || [];
  }

  /**
   * The initial state _before_ evaluating any microsteps.
   * This "pre-initial" state is provided to initial actions executed in the initial state.
   */
  private getPreInitialState(
    actorCtx: ActorContext<any, any> | undefined
  ): State<TContext, TEvent, TResolvedTypesMeta> {
    const [context, actions] = this.getContextAndActions();
    const preInitial = this.resolveState(
      this.createState({
        value: getStateValue(this.root, getConfiguration([this.root])),
        context,
        _event: (createInitEvent({}) as unknown) as SCXML.Event<TEvent>, // TODO: fix
        _sessionid: actorCtx?.sessionId ?? undefined,
        actions: [],
        meta: undefined,
        configuration: [],
        transitions: [],
        children: {}
      })
    );
    preInitial._initial = true;
    preInitial.actions.unshift(...actions);

    if (actorCtx) {
      for (const action of actions) {
        execAction(action, preInitial, actorCtx);
      }
    }

    return preInitial;
  }

  /**
   * The initial State instance, which includes all actions to be executed from
   * entering the initial state.
   */
  public get initialState(): State<
    TContext,
    TEvent,
    TResolvedTypesMeta,
    TTypes
  > {
    return this.getInitialState();
  }

  /**
   * Returns the initial `State` instance, with reference to `self` as an `ActorRef`.
   */
  public getInitialState(
    actorCtx?: ActorContext<TEvent, State<TContext, TEvent>>
  ): State<TContext, TEvent, TResolvedTypesMeta, TTypes> {
    const initEvent = this.getInitEvent();
    const preInitialState = this.getPreInitialState(actorCtx);
    const nextState = microstep([], preInitialState, actorCtx, initEvent);
    nextState.actions.unshift(...preInitialState.actions);

    const { state: macroState } = macrostep(nextState, initEvent, actorCtx);

    return macroState;
  }

  public getInitEvent(): SCXML.Event<TEvent> {
    return (toSCXMLEvent({
      type: actionTypes.init,
      input: this.options.input
    }) as unknown) as SCXML.Event<TEvent>; // TODO: fix
  }

  public getStateNodeById(stateId: string): StateNode<TContext, TEvent> {
    const resolvedStateId = isStateId(stateId)
      ? stateId.slice(STATE_IDENTIFIER.length)
      : stateId;

    const stateNode = this.idMap.get(resolvedStateId);
    if (!stateNode) {
      throw new Error(
        `Child state node '#${resolvedStateId}' does not exist on machine '${this.id}'`
      );
    }
    return stateNode;
  }

  public get definition(): StateNodeDefinition<TContext, TEvent> {
    return this.root.definition;
  }

  public toJSON() {
    return this.definition;
  }

  public createState(
    stateConfig:
      | State<TContext, TEvent, TResolvedTypesMeta>
      | StateConfig<TContext, TEvent>
  ): State<TContext, TEvent, TResolvedTypesMeta> {
    const state =
      stateConfig instanceof State ? stateConfig : new State(stateConfig, this);

    state.machine = this;
    return state as State<TContext, TEvent, TResolvedTypesMeta>;
  }

  public getStatus(state: State<TContext, TEvent, TResolvedTypesMeta>) {
    return state.done
      ? { status: 'done', data: state.output }
      : { status: 'active' };
  }

  public restoreState(
    state: State<TContext, TEvent, TResolvedTypesMeta> | StateValue,
    actorCtx?: ActorContext<TEvent, State<TContext, TEvent>>
  ): State<TContext, TEvent, TResolvedTypesMeta> {
    const restoredState = isStateConfig(state)
      ? this.resolveState(state as any)
      : this.resolveState(State.from(state as any, this.context, this));

    if (actorCtx) {
      for (const action of restoredState.actions) {
        execAction(action, restoredState, actorCtx);
      }
    }

    return restoredState;
  }

  public withInput(
    input: TTypes['input']
  ): StateMachine<
    TContext,
    TEvent,
    TAction,
    TActorMap,
    TResolvedTypesMeta,
    TTypes,
    TProvided & { input: TTypes['input'] }
  > {
    return new StateMachine(this.config, {
      ...this.options,
      input
    });
  }

  /**@deprecated an internal property acting as a "phantom" type, not meant to be used at runtime */
  __TContext!: TContext;
  /** @deprecated an internal property acting as a "phantom" type, not meant to be used at runtime */
  __TEvent!: TEvent;
  /** @deprecated an internal property acting as a "phantom" type, not meant to be used at runtime */
  __TAction!: TAction;
  /** @deprecated an internal property acting as a "phantom" type, not meant to be used at runtime */
  __TActorMap!: TActorMap;
  /** @deprecated an internal property acting as a "phantom" type, not meant to be used at runtime */
  __TResolvedTypesMeta!: TResolvedTypesMeta;
  __TTypes!: TTypes;
  __TProvided!: TProvided;
}

export function createMachine2<
  TPartialTypes extends PartialMachineTypes,
  TTypes extends MachineTypes<TPartialTypes> = MachineTypes<TPartialTypes>,
  TProvided extends MachineImplementations2<TTypes> = MachineImplementations2<TTypes>
>(
  config: MachineConfig2<TPartialTypes>,
  implementations?: TProvided
): StateMachine<
  TTypes['context'],
  TTypes['events'],
  TTypes['actions'],
  any,
  any,
  TTypes,
  TProvided
> {
  return new StateMachine(config as any, implementations as any) as any;
}

export function createMachine<
  TContext extends MachineContext,
  TEvent extends EventObject = AnyEventObject,
  TActorMap extends ActorMap = ActorMap,
  TTypesMeta extends TypegenConstraint = TypegenDisabled
>(
  config: MachineConfig<
    TContext,
    TEvent,
    BaseActionObject,
    TActorMap,
    TTypesMeta
  >,
  implementations?: InternalMachineImplementations<
    TContext,
    TEvent,
    ResolveTypegenMeta<TTypesMeta, TEvent, BaseActionObject, TActorMap>
  >
): StateMachine<
  TContext,
  TEvent,
  BaseActionObject,
  TActorMap,
  ResolveTypegenMeta<TTypesMeta, TEvent, BaseActionObject, TActorMap>
> {
  return new StateMachine<any, any, any, any, any>(
    config,
    implementations as any
  );
}
