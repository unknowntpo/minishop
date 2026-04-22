package e2e_test

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("go-backend buyer APIs", func() {
	It("serves buyer APIs without a Next app service present", Label("smoke", "full"), func() {
		lookupCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()

		_, err := net.DefaultResolver.LookupHost(lookupCtx, "app")
		Expect(err).To(HaveOccurred())

		status, body, err := testEnv.requestJSON(context.Background(), http.MethodPost, "/api/checkout-intents", createCheckoutIntentRequest{
			BuyerID: "buyer_without_next",
			Items: []requestItem{
				{
					SkuID:                "sku_tee_001",
					Quantity:             1,
					UnitPriceAmountMinor: 68000,
					Currency:             "TWD",
				},
			},
		})
		Expect(err).NotTo(HaveOccurred())
		Expect(status).To(Equal(http.StatusAccepted))

		response := createCheckoutIntentResponse{}
		Expect(json.Unmarshal(body, &response)).To(Succeed())
		Expect(response.Status).To(Equal("queued"))
		Expect(response.CheckoutIntentID).NotTo(BeEmpty())
		Expect(response.IdempotentReplay).To(BeFalse())
	})

	It("processes a regular buy-intent end to end", Label("smoke", "full"), func() {
		status, body, err := testEnv.requestJSON(context.Background(), http.MethodPost, "/api/buy-intents", createBuyIntentRequest{
			BuyerID: "buyer_regular",
			Items: []requestItem{
				{
					SkuID:                "sku_tee_001",
					Quantity:             1,
					UnitPriceAmountMinor: 68000,
					Currency:             "TWD",
				},
			},
		})
		Expect(err).NotTo(HaveOccurred())
		Expect(status).To(Equal(http.StatusAccepted))

		accepted := acceptBuyIntentResponse{}
		Expect(json.Unmarshal(body, &accepted)).To(Succeed())
		Expect(accepted.Status).To(Equal("accepted"))
		Expect(accepted.CommandID).NotTo(BeEmpty())
		Expect(accepted.CorrelationID).NotTo(BeEmpty())

		var commandStatus commandStatusResponse
		Eventually(func() error {
			readStatus, result, _, err := testEnv.readCommandStatus(context.Background(), accepted.CommandID)
			if err != nil {
				return err
			}
			if readStatus == http.StatusNotFound {
				return errors.New("command status not visible yet")
			}
			if result.Status != "created" {
				return errors.New("command not created yet")
			}
			if result.CheckoutIntentID == nil || *result.CheckoutIntentID == "" {
				return errors.New("checkout intent id missing")
			}
			commandStatus = result
			return nil
		}).Should(Succeed())

		var projection checkoutIntentResponse
		Eventually(func() error {
			_, _, err := testEnv.processProjections(context.Background())
			if err != nil {
				return err
			}
			readStatus, result, _, err := testEnv.readCheckoutIntent(context.Background(), *commandStatus.CheckoutIntentID)
			if err != nil {
				return err
			}
			if readStatus == http.StatusNotFound {
				return errors.New("projection not visible yet")
			}
			projection = result
			return nil
		}).Should(Succeed())
		Expect(projection.Status).To(Equal("queued"))

		completeStatus, completeBody, err := testEnv.requestJSON(context.Background(), http.MethodPost, "/api/internal/checkout-intents/"+*commandStatus.CheckoutIntentID+"/complete-demo", nil)
		Expect(err).NotTo(HaveOccurred())
		Expect(completeStatus).To(Equal(http.StatusOK))

		completed := completeDemoCheckoutResponse{}
		Expect(json.Unmarshal(completeBody, &completed)).To(Succeed())
		Expect(completed.Status).To(Equal("confirmed"))
		Expect(completed.OrderID).NotTo(BeNil())
		Expect(completed.PaymentID).NotTo(BeNil())

		Eventually(func() (string, error) {
			_, _, err := testEnv.processProjections(context.Background())
			if err != nil {
				return "", err
			}
			readStatus, result, _, err := testEnv.readCheckoutIntent(context.Background(), *commandStatus.CheckoutIntentID)
			if err != nil {
				return "", err
			}
			if readStatus != http.StatusOK {
				return "", errors.New("projection not readable yet")
			}
			return result.Status, nil
		}).Should(Equal("confirmed"))
	})

	It("dedupes a regular buy-intent replay", Label("full"), func() {
		request := createBuyIntentRequest{
			BuyerID: "buyer_duplicate",
			Items: []requestItem{
				{
					SkuID:                "sku_tee_001",
					Quantity:             1,
					UnitPriceAmountMinor: 68000,
					Currency:             "TWD",
				},
			},
		}

		firstStatus, firstBody, err := testEnv.requestJSONWithHeaders(context.Background(), http.MethodPost, "/api/buy-intents", request, map[string]string{
			"Idempotency-Key": "regular-replay-1",
		})
		Expect(err).NotTo(HaveOccurred())
		Expect(firstStatus).To(Equal(http.StatusAccepted))

		secondStatus, secondBody, err := testEnv.requestJSONWithHeaders(context.Background(), http.MethodPost, "/api/buy-intents", request, map[string]string{
			"Idempotency-Key": "regular-replay-1",
		})
		Expect(err).NotTo(HaveOccurred())
		Expect(secondStatus).To(Equal(http.StatusAccepted))

		firstAccepted := acceptBuyIntentResponse{}
		secondAccepted := acceptBuyIntentResponse{}
		Expect(json.Unmarshal(firstBody, &firstAccepted)).To(Succeed())
		Expect(json.Unmarshal(secondBody, &secondAccepted)).To(Succeed())

		var firstCommand commandStatusResponse
		var secondCommand commandStatusResponse

		Eventually(func() error {
			status, result, _, err := testEnv.readCommandStatus(context.Background(), firstAccepted.CommandID)
			if err != nil {
				return err
			}
			if status != http.StatusOK || result.Status != "created" || result.CheckoutIntentID == nil {
				return errors.New("first command not created yet")
			}
			firstCommand = result
			return nil
		}).Should(Succeed())

		Eventually(func() error {
			status, result, _, err := testEnv.readCommandStatus(context.Background(), secondAccepted.CommandID)
			if err != nil {
				return err
			}
			if status != http.StatusOK || result.Status != "created" || result.CheckoutIntentID == nil {
				return errors.New("second command not created yet")
			}
			secondCommand = result
			return nil
		}).Should(Succeed())

		Expect(firstCommand.IsDuplicate).To(BeFalse())
		Expect(secondCommand.IsDuplicate).To(BeTrue())
		Expect(*secondCommand.CheckoutIntentID).To(Equal(*firstCommand.CheckoutIntentID))
		Expect(secondCommand.EventID).NotTo(BeNil())
		Expect(firstCommand.EventID).NotTo(BeNil())
		Expect(*secondCommand.EventID).To(Equal(*firstCommand.EventID))

		count, err := testEnv.queryCheckoutEventCount(context.Background())
		Expect(err).NotTo(HaveOccurred())
		Expect(count).To(Equal(1))
	})

	It("creates and replays checkout intents idempotently", Label("full"), func() {
		request := createCheckoutIntentRequest{
			BuyerID: "buyer_checkout",
			Items: []requestItem{
				{
					SkuID:                "sku_tee_001",
					Quantity:             1,
					UnitPriceAmountMinor: 68000,
					Currency:             "TWD",
				},
			},
		}

		firstStatus, firstBody, err := testEnv.requestJSONWithHeaders(context.Background(), http.MethodPost, "/api/checkout-intents", request, map[string]string{
			"Idempotency-Key": "checkout-replay-1",
		})
		Expect(err).NotTo(HaveOccurred())
		Expect(firstStatus).To(Equal(http.StatusAccepted))

		first := createCheckoutIntentResponse{}
		Expect(json.Unmarshal(firstBody, &first)).To(Succeed())
		Expect(first.Status).To(Equal("queued"))
		Expect(first.IdempotentReplay).To(BeFalse())

		Eventually(func() error {
			_, _, err := testEnv.processProjections(context.Background())
			if err != nil {
				return err
			}
			status, result, _, err := testEnv.readCheckoutIntent(context.Background(), first.CheckoutIntentID)
			if err != nil {
				return err
			}
			if status != http.StatusOK {
				return errors.New("checkout projection not ready")
			}
			if result.Status != "queued" {
				return errors.New("checkout projection in unexpected state")
			}
			return nil
		}).Should(Succeed())

		secondStatus, secondBody, err := testEnv.requestJSONWithHeaders(context.Background(), http.MethodPost, "/api/checkout-intents", request, map[string]string{
			"Idempotency-Key": "checkout-replay-1",
		})
		Expect(err).NotTo(HaveOccurred())
		Expect(secondStatus).To(Equal(http.StatusOK))

		second := createCheckoutIntentResponse{}
		Expect(json.Unmarshal(secondBody, &second)).To(Succeed())
		Expect(second.IdempotentReplay).To(BeTrue())
		Expect(second.CheckoutIntentID).To(Equal(first.CheckoutIntentID))
		Expect(second.EventID).To(Equal(first.EventID))

		count, err := testEnv.queryCheckoutEventCount(context.Background())
		Expect(err).NotTo(HaveOccurred())
		Expect(count).To(Equal(1))
	})

	It("processes a seckill single-SKU flow through the Go backend", Label("full"), func() {
		Expect(testEnv.enableSeckill(context.Background(), "sku_hot_001", 5, 100)).To(Succeed())

		status, body, err := testEnv.requestJSON(context.Background(), http.MethodPost, "/api/buy-intents", createBuyIntentRequest{
			BuyerID: "buyer_seckill_success",
			Items: []requestItem{
				{
					SkuID:                "sku_hot_001",
					Quantity:             1,
					UnitPriceAmountMinor: 100000,
					Currency:             "TWD",
				},
			},
		})
		Expect(err).NotTo(HaveOccurred())
		Expect(status).To(Equal(http.StatusAccepted))

		accepted := acceptBuyIntentResponse{}
		Expect(json.Unmarshal(body, &accepted)).To(Succeed())

		var commandStatus commandStatusResponse
		Eventually(func() error {
			readStatus, result, _, err := testEnv.readCommandStatus(context.Background(), accepted.CommandID)
			if err != nil {
				return err
			}
			if readStatus != http.StatusOK || result.Status != "created" || result.CheckoutIntentID == nil {
				return errors.New("seckill command not created yet")
			}
			commandStatus = result
			return nil
		}, "45s", "500ms").Should(Succeed())

		Eventually(func() error {
			result, err := testEnv.readSeckillCommandResult(context.Background(), accepted.CommandID)
			if err != nil {
				return err
			}
			if result.Status != "reserved" {
				return errors.New("seckill result not reserved yet")
			}
			if result.CheckoutIntentID == nil || *result.CheckoutIntentID != *commandStatus.CheckoutIntentID {
				return errors.New("checkout intent id mismatch")
			}
			return nil
		}, "45s", "500ms").Should(Succeed())

		Eventually(func() error {
			_, _, err := testEnv.processProjections(context.Background())
			if err != nil {
				return err
			}
			status, result, _, err := testEnv.readCheckoutIntent(context.Background(), *commandStatus.CheckoutIntentID)
			if err != nil {
				return err
			}
			if status != http.StatusOK {
				return errors.New("seckill projection not ready")
			}
			if result.Status != "queued" {
				return errors.New("unexpected seckill projection status")
			}
			return nil
		}).Should(Succeed())
	})

	It("rejects mixed-cart requests when a seckill SKU is present", Label("smoke", "full"), func() {
		Expect(testEnv.enableSeckill(context.Background(), "sku_hot_001", 5, 100)).To(Succeed())

		status, body, err := testEnv.requestJSON(context.Background(), http.MethodPost, "/api/buy-intents", createBuyIntentRequest{
			BuyerID: "buyer_mixed_cart",
			Items: []requestItem{
				{
					SkuID:                "sku_hot_001",
					Quantity:             1,
					UnitPriceAmountMinor: 100000,
					Currency:             "TWD",
				},
				{
					SkuID:                "sku_tee_001",
					Quantity:             1,
					UnitPriceAmountMinor: 68000,
					Currency:             "TWD",
				},
			},
		})
		Expect(err).NotTo(HaveOccurred())
		Expect(status).To(Equal(http.StatusBadRequest))

		apiError := apiErrorResponse{}
		Expect(json.Unmarshal(body, &apiError)).To(Succeed())
		Expect(apiError.Error).To(Equal("Mixed cart with seckill SKU is not supported. Please checkout seckill items separately."))
		Expect(apiError.RequestID).NotTo(BeEmpty())
	})

	It("surfaces seckill terminal failure semantics", Label("full"), func() {
		Expect(testEnv.enableSeckill(context.Background(), "sku_cap_001", 1, 100)).To(Succeed())

		status, body, err := testEnv.requestJSON(context.Background(), http.MethodPost, "/api/buy-intents", createBuyIntentRequest{
			BuyerID: "buyer_seckill_failure",
			Items: []requestItem{
				{
					SkuID:                "sku_cap_001",
					Quantity:             2,
					UnitPriceAmountMinor: 42000,
					Currency:             "TWD",
				},
			},
		})
		Expect(err).NotTo(HaveOccurred())
		Expect(status).To(Equal(http.StatusAccepted))

		accepted := acceptBuyIntentResponse{}
		Expect(json.Unmarshal(body, &accepted)).To(Succeed())

		Eventually(func() error {
			readStatus, result, _, err := testEnv.readCommandStatus(context.Background(), accepted.CommandID)
			if err != nil {
				return err
			}
			if readStatus != http.StatusOK || result.Status != "failed" {
				return errors.New("seckill command not failed yet")
			}
			if result.FailureCode == nil || *result.FailureCode != "seckill_out_of_stock" {
				return errors.New("failure code not populated yet")
			}
			if result.FailureMessage == nil || *result.FailureMessage != "seckill_out_of_stock" {
				return errors.New("failure message not populated yet")
			}
			return nil
		}, "45s", "500ms").Should(Succeed())

		Eventually(func() error {
			result, err := testEnv.readSeckillCommandResult(context.Background(), accepted.CommandID)
			if err != nil {
				return err
			}
			if result.Status != "rejected" {
				return errors.New("seckill result not rejected yet")
			}
			if result.FailureReason == nil || *result.FailureReason != "seckill_out_of_stock" {
				return errors.New("seckill failure reason not recorded yet")
			}
			return nil
		}, "45s", "500ms").Should(Succeed())
	})
})
