export type Clock = {
  now(): Date;
};

export const systemClock: Clock = {
  now() {
    return new Date();
  },
};
