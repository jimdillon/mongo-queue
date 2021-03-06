'use strict'

var dbUrl = process.env.QUEUE_TEST_URL

var retryQueue = require('./queue')
var index = require('../index')
var db = require('./db')(dbUrl)

var xtend = require('xtend')
var sinon = require('sinon')
var Promise = require('bluebird')
var expect = require('chai').expect
require('sinon-as-promised')(Promise)

var collectionName = 'PAYLOAD_QUEUE'

function getDb () {
  return db.getCollection(collectionName)
}

function getAllRecords () {
  return getDb().then(function (c) {
    return c.find().toArray()
  })
}

function removeAll () {
  return getDb().call('remove')
}

describe(__filename, function () {
  var onProcessStub
  var onFailureStub

  function createQueue (overrides) {
    overrides = overrides || {}
    return retryQueue(xtend({
      collectionName: collectionName,
      batchSize: 10,
      retryLimit: 1,
      maxRecordAge: 10000,
      onProcess: onProcessStub,
      onFailure: onFailureStub,
      mongoUrl: dbUrl
    }, overrides))
  }

  beforeEach(function () {
    onProcessStub = sinon.stub().resolves()
    onFailureStub = sinon.stub().resolves()
  })

  beforeEach(removeAll)

  describe('#Enqueue', function () {
    it('Should enqueue records', function () {
      var queue = createQueue()

      return queue.enqueue({foo: true, id: 'myId'})
        .then(function (res) {
          // Make sure that enqueue returns the created object
          expect(res).to.have.property('_id')
          expect(res).to.have.property('id')
          expect(res).to.have.property('receivedDate')
          expect(res).to.have.property('status', 'received')
          expect(res).to.have.property('data')
          expect(res.data).to.eql({foo: true, id: 'myId'})
        })
    })
  })

  it('Should happy path', function () {
    var queue = createQueue()

    return queue.enqueue({foo: true})
      .then(function () {
        return queue.processNextBatch()
      })
      .then(function () {
        // Expect the record we just added to be passed to the processor
        expect(onProcessStub.callCount).to.eql(1)
        expect(onProcessStub.getCall(0).args[0]).to.have.property('status', 'received')
        expect(onProcessStub.getCall(0).args[0]).to.have.property('receivedDate')
        expect(onProcessStub.getCall(0).args[0]).to.have.property('id')
        expect(onProcessStub.getCall(0).args[0]).to.have.property('data')
        expect(onProcessStub.getCall(0).args[0].data).to.eql({foo: true})
        expect(onFailureStub.callCount).to.eql(0)
      })
      .then(function () {
        // Try processing again, make sure we don't re-process the same record twice
        return queue.processNextBatch()
      })
      .then(function () {
        expect(onProcessStub.callCount).to.eql(1) // Still is 1
        expect(onFailureStub.callCount).to.eql(0) // Still is 0
      })
  })

  it('Should process only batchSize each time', function () {
    var queue = createQueue({
      batchSize: 1
    })

    // Add two records, and make sure each is processed individually because batchSize == 1
    return Promise.all([queue.enqueue({foo: 1}), queue.enqueue({foo: 2})])
      .then(function () {
        return queue.processNextBatch()
      })
      .then(function () {
        // Expect the first record we just added to be passed to the processor
        expect(onProcessStub.callCount).to.eql(1)
        expect(onProcessStub.getCall(0).args[0]).to.have.property('status', 'received')
        expect(onProcessStub.getCall(0).args[0]).to.have.property('receivedDate')
        expect(onProcessStub.getCall(0).args[0]).to.have.property('id')

        expect(onProcessStub.getCall(0).args[0]).to.have.property('data')
        expect(onProcessStub.getCall(0).args[0].data).to.eql({foo: 1})

        expect(onFailureStub.callCount).to.eql(0)
      })
      .then(function () {
        // Process the next batch
        return queue.processNextBatch()
      })
      .then(function () {
        // Expect the SECOND record we just added to be passed to the processor
        expect(onProcessStub.callCount).to.eql(2)
        expect(onProcessStub.getCall(1).args[0]).to.have.property('status', 'received')
        expect(onProcessStub.getCall(1).args[0]).to.have.property('receivedDate')
        expect(onProcessStub.getCall(1).args[0]).to.have.property('id')

        expect(onProcessStub.getCall(1).args[0]).to.have.property('data')
        expect(onProcessStub.getCall(1).args[0].data).to.eql({foo: 2})

        expect(onFailureStub.callCount).to.eql(0)
      })
  })

  it('Should use a given condition function when getting next batch', function () {
    var queue = createQueue({
      conditionFn: function () {
        return {
          data: {
            foo: true
          }
        }
      }
    })

    return Promise.all([queue.enqueue({foo: true}), queue.enqueue({foo: false})])
      .then(function () {
        return queue.processNextBatch()
      })
      .then(function () {
        // Expect the first record we just added to be passed to the processor
        expect(onProcessStub.callCount).to.eql(1)
        expect(onProcessStub.getCall(0).args[0].data).to.have.property('foo', true)

        expect(onFailureStub.callCount).to.eql(0)
      })
  })

  describe('#Failures in processing', function () {
    it('Should not retry and immediately notify if a retryLimit is not set', function () {
      onProcessStub.onCall(0).rejects(new Error('boo'))

      var queue = createQueue()

      return queue.enqueue({foo: 1})
        .then(function () {
          // Process it successfully
          return queue.processNextBatch()
        })
        .then(function () {
          expect(onProcessStub.callCount).to.eql(1)
        })
        .then(getAllRecords)
        .then(function (records) {
          expect(records.length).to.eql(1)
          expect(records[0]).to.have.property('status', 'failed')
          expect(records[0]).to.have.property('retryCount', 1)
          expect(records[0]).to.have.property('failureReason').that.contains('boo')
        })
        .then(function () {
          // The second time we process it will be marked as failed
          return queue.processNextBatch()
        })
        .then(getAllRecords)
        .then(function (records) {
          expect(onProcessStub.callCount).to.eql(1)

          expect(records.length).to.eql(1)
          expect(records[0]).to.have.property('status', 'notified')
        })
    })

    it('Should retry a failure', function () {
      onProcessStub.onCall(0).rejects(new Error('boo'))
      onProcessStub.onCall(1).resolves()

      var queue = createQueue({
        batchSize: 1,
        retryLimit: 2
      })

      return queue.enqueue({foo: 1})
        .then(function () {
          // Process it successfully
          return queue.processNextBatch()
        })
        .then(function () {
          expect(onProcessStub.callCount).to.eql(1)
          expect(onFailureStub.callCount).to.eql(0)
        })
        .then(getAllRecords)
        .then(function (records) {
          expect(records.length).to.eql(1)
          expect(records[0]).to.have.property('status', 'failed')
          expect(records[0]).to.have.property('retryCount', 1)
          expect(records[0]).to.have.property('failureReason').that.contains('boo')
        })
        .then(function () {
          // Try again!
          return queue.processNextBatch()
        })
        .then(function () {
          expect(onProcessStub.callCount).to.eql(2)
          expect(onFailureStub.callCount).to.eql(0)
        })
        .then(getAllRecords)
        .then(function (records) {
          // Should be successful this time
          expect(records.length).to.eql(1)
          expect(records[0]).to.have.property('status', 'processed')
          expect(records[0]).to.not.have.property('retryCount')
          expect(records[0].failureReason).not.exist
        })
    })

    it('Should call the onFailure function when it reaches the retryLimit', function () {
      onProcessStub.rejects(new Error('boo'))

      var queue = createQueue({
        batchSize: 1,
        retryLimit: 3
      })

      return queue.enqueue({foo: 1})
        .then(function () {
          return queue.processNextBatch()
        })
        .then(function () {
          expect(onProcessStub.callCount).to.eql(1)
          expect(onFailureStub.callCount).to.eql(0)
        })
        .then(function () {
          // Retry once...
          return queue.processNextBatch()
        })
        .then(function () {
          expect(onProcessStub.callCount).to.eql(2)
          expect(onFailureStub.callCount).to.eql(0)
        })
        .then(function () {
          // Twice...
          return queue.processNextBatch()
        })
        .then(function () {
          expect(onProcessStub.callCount).to.eql(3)
          expect(onFailureStub.callCount).to.eql(0)
        })
        .then(function () {
          // Three times, the failure...
          return queue.processNextBatch()
        })
        .then(function () {
          expect(onProcessStub.callCount).to.eql(3)
          expect(onFailureStub.callCount).to.eql(1)
        })
        .then(getAllRecords)
        .then(function (records) {
          expect(records.length).to.eql(1)
          expect(records[0]).to.have.property('retryCount', 3)
          expect(records[0]).to.have.property('status', 'notified')
        })
        .then(function () {
          // Make sure if we process again, it doesn't get picked up again
          return queue.processNextBatch()
        })
        .then(function () {
          // Should still be the same as before
          expect(onProcessStub.callCount).to.eql(3)
          expect(onFailureStub.callCount).to.eql(1)
        })
    })

    it('Should backoff exponentially on errors', function () {
      onProcessStub.rejects(new Error('boo'))

      var queue = createQueue({
        retryLimit: 3,
        backoffMs: 50
      })

      return queue.enqueue({foo: 1})
        .then(function () {
          return queue.processNextBatch()
        })
        .then(function () {
          expect(onProcessStub.callCount).to.eql(1)
          expect(onFailureStub.callCount).to.eql(0)
        })
        .then(function () {
          return queue.processNextBatch()
        })
        .then(function () {
          // Should not have processed the record so soon
          expect(onProcessStub.callCount).to.eql(1)
          expect(onFailureStub.callCount).to.eql(0)
        })
        .then(function () {
          return Promise.delay(51)
        })
        .then(function () {
          return queue.processNextBatch()
        })
        .then(function () {
          // We've waited long enough, should process
          expect(onProcessStub.callCount).to.eql(2)
          expect(onFailureStub.callCount).to.eql(0)
        })
        .then(function () {
          return Promise.delay(51)
        })
        .then(function () {
          return queue.processNextBatch()
        })
        .then(function () {
          // 50ms should not have been enough to process again yet
          expect(onProcessStub.callCount).to.eql(2)
          expect(onFailureStub.callCount).to.eql(0)
        })
        .then(function () {
          return Promise.delay(150)
        })
        .then(function () {
          return queue.processNextBatch()
        })
        .then(function () {
          // We've waited long enough, should process
          expect(onProcessStub.callCount).to.eql(3)
          expect(onFailureStub.callCount).to.eql(0)
        })
    })
  })

  describe('#Cleanup', function () {
    it('Should clean up records beyond their maxRecordAge', function () {
      var queue = createQueue({
        maxRecordAge: 100
      })

      return queue.enqueue({foo: 1})
        .then(function () {
          // Process it successfully
          return queue.processNextBatch()
        })
        .then(function () {
          return Promise.delay(150) // Wait for the processed record to expire
        })
        .then(function () {
          // Add a second record that will not be processed.
          // This one should not be deleted when cleaning up!
          return queue.enqueue({foo: 2})
        })
        .then(function () {
          return queue.cleanup()
        })
        .then(getAllRecords)
        .then(function (records) {
          // We should have deleted the first record, but kept the second
          expect(records.length).to.eql(1)
          expect(records[0]).to.have.property('data')
          expect(records[0].data).to.eql({foo: 2})
        })
    })
  })

  describe('#fail', function () {
    it('Should fail the record immediately and not reprocess it if fail is called', function () {
      onProcessStub.rejects(index.fail('Validation failure'))

      var queue = createQueue()

      return queue.enqueue({foo: true})
      .then(function () {
        return queue.processNextBatch()
      })
      .then(function () {
        expect(onProcessStub.callCount).to.eql(1)
        expect(onProcessStub.getCall(0).args[0].data).to.eql({foo: true})
        expect(onFailureStub.callCount).to.eql(1)
      })
      .then(getAllRecords)
      .then(function (records) {
        expect(records.length).to.eql(1)
        // Should have been updated to 'skipped' in mongo
        expect(records[0]).to.have.property('status', 'notified')
        expect(records[0]).to.have.property('processedDate')
        expect(records[0]).to.not.have.property('retryCount')
        expect(records[0]).to.have.property('failureReason', 'Validation failure')
      })
      .then(function () {
        return queue.processNextBatch()
      })
      .then(function () {
        // Nothing should have processed again
        expect(onProcessStub.callCount).to.eql(1)
        expect(onFailureStub.callCount).to.eql(1)
      })
    })
  })

  describe('#skip', function () {
    it('Should not update the record status is skip is called', function () {
      // First call we'll tell it to skip the record
      // Second call should update the status like normal
      onProcessStub.onCall(0).rejects(index.skip(100))
      onProcessStub.onCall(1).resolves()

      var queue = createQueue()

      return queue.enqueue({foo: true})
      .then(function () {
        return queue.processNextBatch()
      })
      .then(function () {
        expect(onProcessStub.callCount).to.eql(1)
        expect(onProcessStub.getCall(0).args[0]).to.have.property('status', 'received')
        expect(onProcessStub.getCall(0).args[0]).to.have.property('receivedDate')
        expect(onProcessStub.getCall(0).args[0]).to.have.property('id')
        expect(onProcessStub.getCall(0).args[0]).to.have.property('data')
        expect(onProcessStub.getCall(0).args[0].data).to.eql({foo: true})
        expect(onFailureStub.callCount).to.eql(0)
      })
      .then(getAllRecords)
      .then(function (records) {
        expect(records.length).to.eql(1)
        // Should have been updated to 'skipped' in mongo
        expect(records[0]).to.have.property('status', 'skipped')
        expect(records[0]).to.have.property('processedDate')
        expect(records[0]).to.not.have.property('retryCount')
        expect(records[0]).to.not.have.property('failureReason')
      })
      .then(function () {
        return queue.processNextBatch()
      })
      .then(function () {
        // Should not process this time because it hasn't been long enough
        expect(onProcessStub.callCount).to.eql(1)
      })
      .then(function () {
        return Promise.delay(150)
      })
      .then(function () {
        // Should not process this time because it hasn't been long enough
        return queue.processNextBatch()
      })
      .then(getAllRecords)
      .then(function (records) {
        expect(onProcessStub.callCount).to.eql(2)

        expect(records.length).to.eql(1)
        expect(records[0]).to.have.property('status', 'processed')
        expect(records[0]).to.not.have.property('retryCount')
        expect(records[0]).to.not.have.property('failureReason')
      })
    })
  })
})
